/**
 * Per-spell `sandbox.required` — more-strict-wins matrix
 *
 * Covers issue #878:
 * - Schema validator accepts/rejects shapes
 * - Runner enforces SANDBOX_REQUIRED when spell opts in but no OS sandbox is active
 * - Runner casts normally when global sandbox is active OR when neither side requires it
 * - Scheduler emits schedule:skipped (not schedule:failed) on SANDBOX_REQUIRED
 *
 * @see https://github.com/eric-cielo/moflo/issues/878
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the platform-sandbox module BEFORE importing anything that pulls it in,
// so the runner sees our deterministic resolver instead of probing the host.
const { resolveEffectiveSandbox } = vi.hoisted(() => ({ resolveEffectiveSandbox: vi.fn() }));
vi.mock('../../spells/core/platform-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../spells/core/platform-sandbox.js')>();
  return { ...actual, resolveEffectiveSandbox };
});

import { validateSpellDefinition } from '../../spells/schema/validator.js';
import { SpellCaster } from '../../spells/core/runner.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import { SpellScheduler, type SpellExecutor } from '../../spells/scheduler/scheduler.js';
import type { SpellSchedule } from '../../spells/scheduler/schedule.types.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import type { SpellResult, SpellError } from '../../spells/types/runner.types.js';
import type { EffectiveSandbox } from '../../spells/core/platform-sandbox.js';
import { makeCommand, makeCredentials, makeMemory } from './helpers.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeEffectiveSandbox(useOsSandbox: boolean): EffectiveSandbox {
  return {
    useOsSandbox,
    capability: {
      platform: 'linux',
      available: useOsSandbox,
      tool: useOsSandbox ? 'bwrap' : null,
      overhead: useOsSandbox ? 'low' : null,
    },
    config: { enabled: useOsSandbox, tier: 'auto' },
    displayStatus: useOsSandbox ? 'OS sandbox: bwrap (linux)' : 'OS sandbox: disabled (denylist active)',
  };
}

function buildRunner() {
  const registry = new StepCommandRegistry();
  registry.register(makeCommand({
    type: 'noop',
    capabilities: [],
    execute: async () => ({ success: true, data: { ok: true } }),
  }));
  return new SpellCaster(registry, makeCredentials(), makeMemory());
}

const SPELL_REQUIRED: SpellDefinition = {
  name: 'must-be-sandboxed',
  sandbox: { required: true },
  steps: [{ id: 's1', type: 'noop', config: {} }],
};

const SPELL_NOT_REQUIRED: SpellDefinition = {
  name: 'free-to-run',
  steps: [{ id: 's1', type: 'noop', config: {} }],
};

beforeEach(() => {
  resolveEffectiveSandbox.mockReset();
});

// ============================================================================
// Validator
// ============================================================================

describe('validator — sandbox block', () => {
  it.each([
    { label: 'missing', sandbox: undefined },
    { label: 'empty object', sandbox: {} },
    { label: 'required: true', sandbox: { required: true } },
    { label: 'required: false', sandbox: { required: false } },
  ])('accepts $label', ({ sandbox }) => {
    const def: SpellDefinition = {
      name: 'ok',
      steps: [{ id: 's1', type: 'noop', config: {} }],
      ...(sandbox !== undefined ? { sandbox } : {}),
    };
    const result = validateSpellDefinition(def, { knownStepTypes: ['noop'] });
    expect(result.errors.filter(e => e.path.startsWith('sandbox'))).toHaveLength(0);
  });

  it('rejects sandbox as a non-object value', () => {
    const def = {
      name: 'bad', steps: [{ id: 's1', type: 'noop', config: {} }],
      sandbox: 'yes',
    } as unknown as SpellDefinition;
    const result = validateSpellDefinition(def, { knownStepTypes: ['noop'] });
    expect(result.errors).toContainEqual({ path: 'sandbox', message: 'sandbox must be an object' });
  });

  it('rejects sandbox.required as a non-boolean', () => {
    const def = {
      name: 'bad', steps: [{ id: 's1', type: 'noop', config: {} }],
      sandbox: { required: 'true' },
    } as unknown as SpellDefinition;
    const result = validateSpellDefinition(def, { knownStepTypes: ['noop'] });
    expect(result.errors).toContainEqual({
      path: 'sandbox.required',
      message: 'sandbox.required must be a boolean',
    });
  });
});

// ============================================================================
// Runner — more-strict-wins matrix
// ============================================================================

describe('runner — more-strict-wins matrix', () => {
  it('Cell 1: global on, spell.sandbox.required=true → cast proceeds (sandboxed)', async () => {
    resolveEffectiveSandbox.mockResolvedValue(makeEffectiveSandbox(true));
    const result = await buildRunner().run(SPELL_REQUIRED, {});
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('Cell 2: global off, spell.sandbox.required=true → SANDBOX_REQUIRED', async () => {
    resolveEffectiveSandbox.mockResolvedValue(makeEffectiveSandbox(false));
    const result = await buildRunner().run(SPELL_REQUIRED, {});
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('SANDBOX_REQUIRED');
    expect(result.errors[0].message).toContain('must-be-sandboxed');
    expect(result.errors[0].message).toContain('sandbox.enabled');
    // No steps should have run
    expect(result.steps).toHaveLength(0);
  });

  it('Cell 3: global off, spell.sandbox.required=false/unset → cast proceeds (no sandbox)', async () => {
    resolveEffectiveSandbox.mockResolvedValue(makeEffectiveSandbox(false));
    const result = await buildRunner().run(SPELL_NOT_REQUIRED, {});
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('Cell 4: global on, spell.sandbox.required=false → cast proceeds (more-strict-wins via global)', async () => {
    resolveEffectiveSandbox.mockResolvedValue(makeEffectiveSandbox(true));
    const result = await buildRunner().run(SPELL_NOT_REQUIRED, {});
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('explicit sandbox.required=false behaves the same as unset', async () => {
    resolveEffectiveSandbox.mockResolvedValue(makeEffectiveSandbox(false));
    const def: SpellDefinition = {
      name: 'opted-out',
      sandbox: { required: false },
      steps: [{ id: 's1', type: 'noop', config: {} }],
    };
    const result = await buildRunner().run(def, {});
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Scheduler — schedule:skipped on SANDBOX_REQUIRED
// ============================================================================

describe('scheduler — SANDBOX_REQUIRED → schedule:skipped', () => {
  function makeSchedulerExecutor(result: SpellResult): SpellExecutor {
    return {
      execute: vi.fn().mockResolvedValue(result),
      exists: () => true,
    };
  }

  function makeFailureResult(error: SpellError): SpellResult {
    return {
      spellId: 'sp-test',
      success: false,
      steps: [],
      outputs: {},
      errors: [error],
      duration: 1,
      cancelled: false,
    };
  }

  function makeFixture(): SpellSchedule {
    return {
      id: 'sched-fixture-1',
      spellName: 'x',
      spellPath: '/x.yaml',
      interval: '1m',
      nextRunAt: Date.now(),
      enabled: true,
      createdAt: Date.now(),
      source: 'adhoc',
    };
  }

  // executeCore is private; cast through `unknown` to drive it directly so we
  // don't have to drag in a memory backend that supports `search()`.
  type SchedulerInternals = {
    executeCore: (s: SpellSchedule, n: number, o: { manual: boolean }) => Promise<unknown>;
  };

  it('emits schedule:skipped (not schedule:failed) when runner returns SANDBOX_REQUIRED', async () => {
    const executor = makeSchedulerExecutor(makeFailureResult({
      code: 'SANDBOX_REQUIRED',
      message: 'Spell "x" requires an OS sandbox but none is active.',
    }));
    const scheduler = new SpellScheduler(makeMemory(), executor);
    const events: string[] = [];
    scheduler.on(e => events.push(`${e.type}:${e.message}`));

    await (scheduler as unknown as SchedulerInternals).executeCore(
      makeFixture(), Date.now(), { manual: true },
    );

    const skipped = events.find(e => e.startsWith('schedule:skipped'));
    const failed = events.find(e => e.startsWith('schedule:failed'));
    expect(skipped).toBeDefined();
    expect(skipped).toContain('OS sandbox');
    expect(failed).toBeUndefined();
  });

  it('still emits schedule:failed for non-sandbox failures', async () => {
    const executor = makeSchedulerExecutor(makeFailureResult({
      code: 'STEP_EXECUTION_FAILED',
      message: 'something else broke',
    }));
    const scheduler = new SpellScheduler(makeMemory(), executor);
    const events: string[] = [];
    scheduler.on(e => events.push(`${e.type}:${e.message}`));

    await (scheduler as unknown as SchedulerInternals).executeCore(
      makeFixture(), Date.now(), { manual: true },
    );

    expect(events.find(e => e.startsWith('schedule:failed'))).toBeDefined();
    expect(events.find(e => e.startsWith('schedule:skipped'))).toBeUndefined();
  });
});
