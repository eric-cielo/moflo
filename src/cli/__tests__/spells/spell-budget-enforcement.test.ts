/**
 * Tests for spend-ceiling enforcement across the runner and the bash step (#1335).
 *
 * `run-budget.test.ts` covers the primitive in isolation. This file covers the
 * two places the ceiling has to actually bite:
 *
 *   1. `bashCommand` — a denied reservation must stop the process from being
 *      spawned at all, because a spawn that is killed afterwards has already
 *      been billed.
 *   2. `SpellCaster` — a breach must end the run, bypass `continueOnError`,
 *      and write the reason into the run's `tasklist` record.
 *
 * The absence cases matter as much as the presence ones: with no ceiling
 * configured the engine must behave exactly as it did before this feature.
 */

import { describe, it, expect, vi } from 'vitest';
import { bashCommand } from '../../spells/commands/bash-command.js';
import { SpellCaster } from '../../spells/core/runner.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import { SpellRunBudget } from '../../spells/core/run-budget.js';
import type { RunBudgetAccessor } from '../../spells/core/run-budget.js';
import { validateSpellDefinition } from '../../spells/schema/validator.js';
import { bridgeExecuteSpell } from '../../spells/factory/runner-bridge.js';
import { ledgerPathFor } from '../../spells/core/run-ledger.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CastingContext,
  CredentialAccessor,
  MemoryAccessor,
  StepCommand,
} from '../../spells/types/step-command.types.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import { createMockContext, MODEL_SHAPED_COMMAND, preAcceptSpell } from './helpers.js';

// ============================================================================
// Helpers
// ============================================================================

function budgetSpy(allow: boolean): RunBudgetAccessor & { calls: number } {
  return {
    calls: 0,
    tryConsumeModelInvocation(this: { calls: number }) { this.calls++; return allow; },
    breach: allow ? null : {
      kind: 'model-invocations', limit: 1, observed: 2, message: 'ceiling hit',
    },
  } as RunBudgetAccessor & { calls: number };
}

const credentials: CredentialAccessor = {
  async get() { return undefined; },
  async has() { return false; },
  async store() { /* no-op */ },
};

/** Records every `tasklist` write so a test can read the terminal record. */
function recordingMemory(): MemoryAccessor & { tasklist: Record<string, unknown>[] } {
  const tasklist: Record<string, unknown>[] = [];
  return {
    tasklist,
    async read() { return null; },
    async write(namespace: string, _key: string, value: unknown) {
      if (namespace === 'tasklist') tasklist.push(value as Record<string, unknown>);
    },
    async search() { return []; },
  };
}

/**
 * A step type standing in for "a step that calls the model", so runner-level
 * tests never spawn a process. It reserves through the context budget exactly
 * the way `bashCommand` does, and fails the step when denied.
 */
function modelStep(): StepCommand {
  return {
    type: 'model',
    description: 'stand-in for a step that spawns claude -p',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    async execute(_config, context: CastingContext) {
      if (context.budget && !context.budget.tryConsumeModelInvocation()) {
        return { success: false, data: {}, error: context.budget.breach?.message ?? 'denied' };
      }
      return { success: true, data: { ok: true } };
    },
    describeOutputs: () => [{ name: 'ok', type: 'boolean' }],
  };
}

/** A step that advances an injected clock, so wall-clock tests need no timers. */
function slowStep(advanceMs: number, clock: { now: number }): StepCommand {
  return {
    type: 'slow',
    description: 'advances the injected clock',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    async execute() {
      clock.now += advanceMs;
      return { success: true, data: {} };
    },
    describeOutputs: () => [],
  };
}

function casterWith(commands: StepCommand[], memory: MemoryAccessor): SpellCaster {
  const registry = new StepCommandRegistry();
  for (const cmd of commands) registry.register(cmd, 'built-in');
  return new SpellCaster(registry, credentials, memory);
}

function modelSpell(stepCount: number, overrides: Partial<SpellDefinition> = {}): SpellDefinition {
  return {
    name: 'budget-spell',
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `m${i + 1}`, type: 'model', config: {},
    })),
    ...overrides,
  };
}

// ============================================================================
// bashCommand — the spawn point
// ============================================================================

describe('bashCommand spend ceiling', () => {
  it('refuses to spawn when the reservation is denied', async () => {
    const budget = budgetSpy(false);
    const output = await bashCommand.execute(
      { command: MODEL_SHAPED_COMMAND },
      createMockContext({ budget }),
    );

    expect(output.success).toBe(false);
    expect(output.error).toContain('ceiling hit');
    // -1 is the engine's "no process ran" exit code. A real spawn of the echo
    // above would have exited 0, so this is what proves nothing was billed.
    expect(output.data.exitCode).toBe(-1);
    expect(output.data.stdout).toBe('');
    expect(budget.calls).toBe(1);
  });

  it('spawns normally when the reservation is granted', async () => {
    const budget = budgetSpy(true);
    const output = await bashCommand.execute(
      { command: MODEL_SHAPED_COMMAND },
      createMockContext({ budget }),
    );

    expect(output.success).toBe(true);
    expect(output.data.exitCode).toBe(0);
    expect(budget.calls).toBe(1);
  });

  it('does not consume budget for a command that spawns no model', async () => {
    const budget = budgetSpy(true);
    const output = await bashCommand.execute(
      { command: 'echo plain' },
      createMockContext({ budget }),
    );

    expect(output.success).toBe(true);
    expect(String(output.data.stdout)).toContain('plain');
    expect(budget.calls).toBe(0);
  });

  it('leaves the step untouched when no budget is configured', async () => {
    const output = await bashCommand.execute(
      { command: MODEL_SHAPED_COMMAND },
      createMockContext(),
    );

    expect(output.success).toBe(true);
    expect(output.data.exitCode).toBe(0);
  });

  it('reserves only after the destructive denylist has had its say', async () => {
    // A command the denylist blocks must not burn a reservation it never used.
    const budget = budgetSpy(true);
    const output = await bashCommand.execute(
      { command: 'claude -p x && rm -rf /' },
      createMockContext({ budget }),
    );

    expect(output.success).toBe(false);
    expect(budget.calls).toBe(0);
  });

  it('does not reserve for a run that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const budget = budgetSpy(true);

    const output = await bashCommand.execute(
      { command: MODEL_SHAPED_COMMAND },
      createMockContext({ budget, abortSignal: controller.signal }),
    );

    expect(output.success).toBe(false);
    expect(budget.calls).toBe(0);
  });
});

// ============================================================================
// SpellCaster — the run loop
// ============================================================================

describe('SpellCaster spend ceiling', () => {
  it('aborts the run when the model-invocation ceiling is spent', async () => {
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);

    const result = await caster.run(modelSpell(4), {}, {
      budget: { maxModelInvocations: 2 },
      skipAcceptanceCheck: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
    expect(result.steps.filter(s => s.status === 'succeeded')).toHaveLength(2);
    // Step 3 is the denial; step 4 never runs.
    expect(result.steps[3].status).toBe('skipped');
  });

  it('bypasses continueOnError — a ceiling a step can opt out of is not a ceiling', async () => {
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);

    const spell: SpellDefinition = {
      name: 'opt-out',
      steps: [
        { id: 'm1', type: 'model', config: {}, continueOnError: true },
        { id: 'm2', type: 'model', config: {}, continueOnError: true },
        { id: 'm3', type: 'model', config: {}, continueOnError: true },
      ],
    };

    const result = await caster.run(spell, {}, {
      budget: { maxModelInvocations: 1 },
      skipAcceptanceCheck: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
    expect(result.steps[2].status).toBe('skipped');
  });

  it('reports a wall-clock breach as BUDGET_EXCEEDED, not SPELL_CANCELLED', async () => {
    // The deadline aborts the run's signal, so without the breach check the
    // run would surface as an ordinary user cancellation and lose the reason.
    const clock = { now: 1_000 };
    const memory = recordingMemory();
    const caster = casterWith([slowStep(400, clock)], memory);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);

    try {
      const spell: SpellDefinition = {
        name: 'slow-spell',
        steps: [
          { id: 's1', type: 'slow', config: {} },
          { id: 's2', type: 'slow', config: {} },
          { id: 's3', type: 'slow', config: {} },
        ],
      };
      const result = await caster.run(spell, {}, {
        budget: { maxWallClockMs: 500 },
        skipAcceptanceCheck: true,
      });

      const codes = result.errors.map(e => e.code);
      expect(codes).toContain('BUDGET_EXCEEDED');
      expect(codes).not.toContain('SPELL_CANCELLED');
      // A ceiling breach is moflo stopping an overrun, not the caller
      // stopping the run — dashboards need to tell those apart.
      expect(result.cancelled).toBe(false);
      expect(result.success).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('interrupts an in-flight step when the deadline fires mid-step', async () => {
    // The between-steps check alone cannot stop a single long-running step —
    // which is the shape a runaway `claude -p` actually takes. This exercises
    // the deadline timer aborting the signal the step is waiting on.
    const hanging: StepCommand = {
      type: 'hanging',
      description: 'waits until the run is aborted',
      configSchema: { type: 'object' },
      validate: () => ({ valid: true, errors: [] }),
      execute(_c, context: CastingContext) {
        return new Promise((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort', () => reject(new Error('aborted')), { once: true },
          );
        });
      },
      describeOutputs: () => [],
    };

    const memory = recordingMemory();
    const caster = casterWith([hanging], memory);
    const result = await caster.run(
      { name: 'hanging-spell', steps: [{ id: 'h1', type: 'hanging', config: {} }] },
      {},
      { budget: { maxWallClockMs: 20 }, skipAcceptanceCheck: true },
    );

    expect(result.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
    expect(result.cancelled).toBe(false);
    expect(memory.tasklist.at(-1)?.budgetBreach).toMatchObject({ kind: 'wall-clock', limit: 20 });
  });

  it('records the breach in the run tasklist record, structured', async () => {
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);

    await caster.run(modelSpell(3), {}, {
      budget: { maxModelInvocations: 1 },
      skipAcceptanceCheck: true,
    });

    const terminal = memory.tasklist.at(-1);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.abortReason).toBe('budget-exceeded');
    expect(terminal?.budgetBreach).toEqual({
      kind: 'model-invocations', limit: 1, observed: 2,
    });
    expect(String(terminal?.error)).toContain('model-invocation ceiling');
  });

  it('composes the definition budget with the caller budget, strictest first', async () => {
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);

    const result = await caster.run(
      modelSpell(4, { budget: { maxModelInvocations: 1 } }),
      {},
      { budget: { maxModelInvocations: 3 }, skipAcceptanceCheck: true },
    );

    expect(result.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
    expect(result.steps.filter(s => s.status === 'succeeded')).toHaveLength(1);
  });

  it('applies a definition budget even when the caller configured none', async () => {
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);

    const result = await caster.run(
      modelSpell(3, { budget: { maxModelInvocations: 1 } }),
      {},
      { skipAcceptanceCheck: true },
    );

    expect(result.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
  });

  it('puts no budget on the casting context when none is configured', async () => {
    // The opt-in guarantee at the surface a step command actually sees.
    const seen: Array<RunBudgetAccessor | undefined> = [];
    const probe: StepCommand = {
      type: 'probe',
      description: 'records the context budget',
      configSchema: { type: 'object' },
      validate: () => ({ valid: true, errors: [] }),
      async execute(_c, context: CastingContext) {
        seen.push(context.budget);
        return { success: true, data: {} };
      },
      describeOutputs: () => [],
    };

    const memory = recordingMemory();
    const caster = casterWith([probe], memory);
    const spell: SpellDefinition = {
      name: 'probe-spell', steps: [{ id: 'p1', type: 'probe', config: {} }],
    };

    const withoutBudget = await caster.run(spell, {}, { skipAcceptanceCheck: true });
    expect(withoutBudget.success).toBe(true);
    expect(seen).toEqual([undefined]);

    seen.length = 0;
    const withBudget = await caster.run(spell, {}, {
      budget: { maxModelInvocations: 5 }, skipAcceptanceCheck: true,
    });
    expect(withBudget.success).toBe(true);
    expect(seen[0]).toBeInstanceOf(SpellRunBudget);
  });

  it('still reports a caller cancellation as SPELL_CANCELLED under a budget', async () => {
    // A budget must not relabel every abort as an overrun.
    const controller = new AbortController();
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);
    controller.abort();

    const result = await caster.run(modelSpell(2), {}, {
      budget: { maxModelInvocations: 5 },
      signal: controller.signal,
      skipAcceptanceCheck: true,
    });

    expect(result.cancelled).toBe(true);
    expect(result.errors.map(e => e.code)).toContain('SPELL_CANCELLED');
    expect(result.errors.map(e => e.code)).not.toContain('BUDGET_EXCEEDED');
  });

  it('runs a spell to completion when it stays inside its ceiling', async () => {
    const memory = recordingMemory();
    const caster = casterWith([modelStep()], memory);

    const result = await caster.run(modelSpell(2), {}, {
      budget: { maxModelInvocations: 5 },
      skipAcceptanceCheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(memory.tasklist.at(-1)?.abortReason).toBeUndefined();
  });
});

// ============================================================================
// End to end, through the bridge the daemon actually calls
// ============================================================================

describe('bridgeExecuteSpell spend ceiling', () => {
  it('aborts a real spell whose bash steps exhaust the invocation ceiling', async () => {
    // The daemon path is DaemonSpellExecutor → bridgeExecuteSpell → SpellCaster
    // → bashCommand. The unit tests above cover each link; this covers the
    // seam between them, using the real runner and the real bash step so a
    // ceiling that never reaches the runner cannot pass.
    const memory = recordingMemory();
    const spell: SpellDefinition = {
      name: 'e2e-budget-spell',
      steps: [
        { id: 'call1', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } },
        { id: 'call2', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } },
      ],
    };

    const result = await bridgeExecuteSpell(spell, {}, {
      spellId: 'scheduled-e2e-budget-spell-1',
      memory,
      budget: { maxModelInvocations: 1 },
    });

    expect(result.success).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
    // Step 1 was allowed to run; step 2 was refused before spawning.
    expect(result.steps[0].status).toBe('succeeded');
    expect(result.steps[1].status).toBe('failed');
    expect(memory.tasklist.at(-1)).toMatchObject({
      abortReason: 'budget-exceeded',
      budgetBreach: { kind: 'model-invocations', limit: 1, observed: 2 },
    });
  });

  it('runs the same spell to completion with no ceiling configured', async () => {
    const memory = recordingMemory();
    const spell: SpellDefinition = {
      name: 'e2e-unbudgeted-spell',
      steps: [
        { id: 'call1', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } },
        { id: 'call2', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } },
      ],
    };

    const result = await bridgeExecuteSpell(spell, {}, {
      spellId: 'scheduled-e2e-unbudgeted-spell-1',
      memory,
    });

    expect(result.success).toBe(true);
    expect(result.steps.every(s => s.status === 'succeeded')).toBe(true);
    expect(memory.tasklist.at(-1)?.abortReason).toBeUndefined();
  });

  it('carries the daily ceiling from one real run into the next (#1380)', async () => {
    // The property a per-run ceiling cannot have. Two separate
    // bridgeExecuteSpell calls — as two consecutive scheduled fires would be —
    // sharing only a project root. If the ledger did not reach the runner, the
    // second run would succeed exactly like the first.
    const projectRoot = mkdtempSync(join(tmpdir(), 'moflo-daily-e2e-'));
    try {
      const spell: SpellDefinition = {
        name: 'e2e-daily-spell',
        steps: [
          { id: 'call1', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } },
          { id: 'call2', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } },
        ],
      };
      await preAcceptSpell(spell, projectRoot);
      const opts = { projectRoot, budget: { dailyModelInvocations: 3 } };

      const first = await bridgeExecuteSpell(spell, {}, {
        ...opts, spellId: 'scheduled-e2e-daily-1', memory: recordingMemory(),
      });
      expect(first.success).toBe(true);

      // Two invocations spent; the ceiling is 3. The second run gets one more
      // and is refused on its second step.
      const memory = recordingMemory();
      const second = await bridgeExecuteSpell(spell, {}, {
        ...opts, spellId: 'scheduled-e2e-daily-2', memory,
      });

      expect(second.success).toBe(false);
      expect(second.errors.map(e => e.code)).toContain('BUDGET_EXCEEDED');
      expect(second.steps[0].status).toBe('succeeded');
      expect(second.steps[1].status).toBe('failed');
      expect(memory.tasklist.at(-1)).toMatchObject({
        abortReason: 'budget-exceeded',
        budgetBreach: { kind: 'daily-model-invocations', limit: 3, observed: 3 },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('leaves consecutive runs uncapped when only per-run ceilings are set', async () => {
    // Guards the inverse: the ledger must not engage for a project that
    // configured no daily ceiling, however many runs it performs.
    const projectRoot = mkdtempSync(join(tmpdir(), 'moflo-daily-off-'));
    try {
      const spell: SpellDefinition = {
        name: 'e2e-perrun-only',
        steps: [{ id: 'call1', type: 'bash', config: { command: MODEL_SHAPED_COMMAND } }],
      };
      await preAcceptSpell(spell, projectRoot);
      const opts = { projectRoot, budget: { maxModelInvocations: 5 } };

      for (const n of [1, 2, 3]) {
        const r = await bridgeExecuteSpell(spell, {}, {
          ...opts, spellId: `scheduled-perrun-${n}`, memory: recordingMemory(),
        });
        expect(r.success).toBe(true);
      }
      expect(existsSync(ledgerPathFor(projectRoot))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Definition validation
// ============================================================================

describe('budget block validation', () => {
  function validate(budget: unknown) {
    const def = {
      name: 'b', steps: [{ id: 's1', type: 'noop', config: {} }],
      ...(budget !== undefined ? { budget } : {}),
    } as unknown as SpellDefinition;
    return validateSpellDefinition(def, { knownStepTypes: ['noop'] })
      .errors.filter(e => e.path.startsWith('budget'));
  }

  it('accepts an absent, empty, or well-formed block', () => {
    expect(validate(undefined)).toHaveLength(0);
    expect(validate({})).toHaveLength(0);
    expect(validate({ maxModelInvocations: 3, maxWallClockMs: 1000 })).toHaveLength(0);
  });

  it('rejects a non-object budget', () => {
    expect(validate('20')).toContainEqual({ path: 'budget', message: 'budget must be an object' });
    expect(validate([1, 2])).toContainEqual({ path: 'budget', message: 'budget must be an object' });
  });

  it('rejects an unknown key rather than silently ignoring it', () => {
    // A typo that parses as "no ceiling" is the failure that costs money: the
    // author believes the spell is capped and the daemon runs it unbounded.
    const errors = validate({ maxModelInvokations: 5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('budget.maxModelInvokations');
    expect(errors[0].message).toContain('maxModelInvocations');
  });

  it('rejects limits that are not positive numbers', () => {
    expect(validate({ maxModelInvocations: 0 })[0].path).toBe('budget.maxModelInvocations');
    expect(validate({ maxWallClockMs: -1 })[0].path).toBe('budget.maxWallClockMs');
    expect(validate({ maxWallClockMs: '1000' })[0].path).toBe('budget.maxWallClockMs');
  });
});
