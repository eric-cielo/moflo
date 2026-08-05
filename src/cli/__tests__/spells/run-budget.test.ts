/**
 * Tests for the spell run budget primitive (#1335).
 *
 * The unit under test is a safety ceiling, so the cases that matter are the
 * ones where a mistake fails OPEN — a config typo silently meaning "no
 * ceiling", a merge that loosens instead of tightens, a breach that does not
 * latch. Each of those leaves an unattended spell unbounded, which is the
 * exact exposure the feature exists to close.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunBudget,
  hasBudgetLimit,
  loadSpellBudgetFromProject,
  mergeSpellBudgets,
  resolveSpellBudgetConfig,
  SpellRunBudget,
} from '../../spells/core/run-budget.js';

const scratchDirs: string[] = [];

function scratchProject(yaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'moflo-budget-'));
  scratchDirs.push(dir);
  if (yaml !== undefined) writeFileSync(join(dir, 'moflo.yaml'), yaml, 'utf-8');
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
});

// ============================================================================
// Config parsing
// ============================================================================

describe('resolveSpellBudgetConfig', () => {
  it('reads camelCase keys', () => {
    expect(resolveSpellBudgetConfig({ maxModelInvocations: 5, maxWallClockMs: 1000 }))
      .toEqual({ maxModelInvocations: 5, maxWallClockMs: 1000 });
  });

  it('reads snake_case keys, matching the sandbox block', () => {
    expect(resolveSpellBudgetConfig({ max_model_invocations: 7, max_wall_clock_ms: 2000 }))
      .toEqual({ maxModelInvocations: 7, maxWallClockMs: 2000 });
  });

  it('drops non-positive and non-numeric limits instead of clamping them', () => {
    // A clamped `0` would become a ceiling nobody asked for; a coerced string
    // would enforce a number the user never wrote. Dropping is the only
    // reading that cannot silently change what runs.
    expect(resolveSpellBudgetConfig({ maxModelInvocations: 0 })).toBeUndefined();
    expect(resolveSpellBudgetConfig({ maxModelInvocations: -3 })).toBeUndefined();
    expect(resolveSpellBudgetConfig({ maxWallClockMs: '5000' })).toBeUndefined();
    expect(resolveSpellBudgetConfig({ maxWallClockMs: Number.NaN })).toBeUndefined();
    expect(resolveSpellBudgetConfig({ maxWallClockMs: Infinity })).toBeUndefined();
  });

  it('keeps the usable half of a partly-broken block', () => {
    expect(resolveSpellBudgetConfig({ maxModelInvocations: 4, maxWallClockMs: -1 }))
      .toEqual({ maxModelInvocations: 4 });
  });

  it('returns undefined for absent, empty, or non-object input', () => {
    expect(resolveSpellBudgetConfig(undefined)).toBeUndefined();
    expect(resolveSpellBudgetConfig({})).toBeUndefined();
    expect(resolveSpellBudgetConfig(null)).toBeUndefined();
    expect(resolveSpellBudgetConfig('20')).toBeUndefined();
  });
});

describe('mergeSpellBudgets', () => {
  it('takes the stricter of each limit', () => {
    expect(mergeSpellBudgets(
      { maxModelInvocations: 20, maxWallClockMs: 1000 },
      { maxModelInvocations: 5, maxWallClockMs: 9000 },
    )).toEqual({ maxModelInvocations: 5, maxWallClockMs: 1000 });
  });

  it('tightens in both directions — neither source is privileged', () => {
    const config = { maxModelInvocations: 10 };
    const definition = { maxModelInvocations: 2 };
    expect(mergeSpellBudgets(config, definition).maxModelInvocations).toBe(2);
    expect(mergeSpellBudgets(definition, config).maxModelInvocations).toBe(2);
  });

  it('carries a limit only one side declares', () => {
    expect(mergeSpellBudgets({ maxModelInvocations: 3 }, { maxWallClockMs: 500 }))
      .toEqual({ maxModelInvocations: 3, maxWallClockMs: 500 });
  });

  it('returns the other side when one is absent', () => {
    expect(mergeSpellBudgets(undefined, { maxWallClockMs: 5 })).toEqual({ maxWallClockMs: 5 });
    expect(mergeSpellBudgets({ maxWallClockMs: 5 }, undefined)).toEqual({ maxWallClockMs: 5 });
    expect(mergeSpellBudgets(undefined, undefined)).toBeUndefined();
  });
});

describe('hasBudgetLimit', () => {
  it('is false for undefined and for an object with no limits', () => {
    expect(hasBudgetLimit(undefined)).toBe(false);
    expect(hasBudgetLimit({})).toBe(false);
  });

  it('is true when either limit is set', () => {
    expect(hasBudgetLimit({ maxModelInvocations: 1 })).toBe(true);
    expect(hasBudgetLimit({ maxWallClockMs: 1 })).toBe(true);
  });
});

// ============================================================================
// moflo.yaml loading
// ============================================================================

describe('loadSpellBudgetFromProject', () => {
  it('reads the scheduled slot', async () => {
    const dir = scratchProject([
      'spells:',
      '  budget:',
      '    scheduled:',
      '      maxModelInvocations: 12',
      '      maxWallClockMs: 600000',
    ].join('\n'));

    expect(await loadSpellBudgetFromProject(dir, 'scheduled'))
      .toEqual({ maxModelInvocations: 12, maxWallClockMs: 600000 });
  });

  it('leaves the interactive path unconfigured when only scheduled is set', async () => {
    // Issue #1335 AC5: session-attached spells are unaffected unless the user
    // explicitly configures them. Configuring the daemon must not reach them.
    const dir = scratchProject([
      'spells:',
      '  budget:',
      '    scheduled:',
      '      maxModelInvocations: 12',
    ].join('\n'));

    expect(await loadSpellBudgetFromProject(dir, 'interactive')).toBeUndefined();
  });

  it('reads the interactive slot when it is configured', async () => {
    const dir = scratchProject([
      'spells:',
      '  budget:',
      '    interactive:',
      '      maxModelInvocations: 50',
    ].join('\n'));

    expect(await loadSpellBudgetFromProject(dir, 'interactive'))
      .toEqual({ maxModelInvocations: 50 });
  });

  it('returns undefined — never throws — for missing, empty, or malformed yaml', async () => {
    expect(await loadSpellBudgetFromProject(scratchProject(), 'scheduled')).toBeUndefined();
    expect(await loadSpellBudgetFromProject(scratchProject('sandbox:\n  enabled: true\n'), 'scheduled'))
      .toBeUndefined();
    expect(await loadSpellBudgetFromProject(scratchProject('spells: [oops\n'), 'scheduled'))
      .toBeUndefined();
    expect(await loadSpellBudgetFromProject(join(tmpdir(), 'moflo-budget-does-not-exist'), 'scheduled'))
      .toBeUndefined();
  });
});

// ============================================================================
// Runtime enforcement
// ============================================================================

describe('createRunBudget', () => {
  it('returns null when nothing is configured — the opt-in guarantee', () => {
    // Not "a permissive budget": with no ceilings the runner must construct
    // nothing at all, so the code path is byte-identical to today's.
    expect(createRunBudget(undefined)).toBeNull();
    expect(createRunBudget({})).toBeNull();
  });

  it('returns a budget when at least one ceiling is set', () => {
    const budget = createRunBudget({ maxModelInvocations: 1 });
    expect(budget).toBeInstanceOf(SpellRunBudget);
    budget?.dispose();
  });
});

describe('SpellRunBudget — model-invocation ceiling', () => {
  it('allows exactly the configured number of reservations', () => {
    const budget = new SpellRunBudget({ maxModelInvocations: 2 });
    expect(budget.tryConsumeModelInvocation()).toBe(true);
    expect(budget.tryConsumeModelInvocation()).toBe(true);
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    expect(budget.modelInvocations).toBe(2);
    budget.dispose();
  });

  it('latches a breach carrying the numbers, not only prose', () => {
    const budget = new SpellRunBudget({ maxModelInvocations: 1 });
    budget.tryConsumeModelInvocation();
    budget.tryConsumeModelInvocation();

    expect(budget.breach).toMatchObject({
      kind: 'model-invocations',
      limit: 1,
      observed: 2,
    });
    expect(budget.breach?.message).toContain('maxModelInvocations');
    budget.dispose();
  });

  it('stays denied once breached', () => {
    const budget = new SpellRunBudget({ maxModelInvocations: 1 });
    budget.tryConsumeModelInvocation();
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    budget.dispose();
  });

  it('does NOT abort the signal — the runner stops the run, not the budget', () => {
    // Aborting here would mark the remaining steps "cancelled" and race the
    // rollback the runner is about to start; the caller is already returning
    // a step failure.
    const budget = new SpellRunBudget({ maxModelInvocations: 1 });
    budget.tryConsumeModelInvocation();
    budget.tryConsumeModelInvocation();

    expect(budget.signal.aborted).toBe(false);
    budget.dispose();
  });

  it('never denies when only a wall-clock ceiling is configured', () => {
    const budget = new SpellRunBudget({ maxWallClockMs: 60_000 });
    for (let i = 0; i < 100; i++) expect(budget.tryConsumeModelInvocation()).toBe(true);
    expect(budget.breach).toBeNull();
    budget.dispose();
  });
});

describe('SpellRunBudget — wall-clock ceiling', () => {
  it('latches and aborts once the deadline passes', () => {
    let now = 1_000;
    const budget = new SpellRunBudget({ maxWallClockMs: 500 }, { now: () => now });

    budget.checkWallClock();
    expect(budget.breach).toBeNull();
    expect(budget.signal.aborted).toBe(false);

    now = 1_600;
    budget.checkWallClock();

    expect(budget.breach).toMatchObject({ kind: 'wall-clock', limit: 500, observed: 600 });
    // Unlike the invocation ceiling there is no in-flight caller to hand a
    // failure to, so aborting is the only way to stop a long-running step.
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it('treats the deadline as reached, not merely passed', () => {
    let now = 0;
    const budget = new SpellRunBudget({ maxWallClockMs: 100 }, { now: () => now });
    now = 100;
    budget.checkWallClock();
    expect(budget.breach?.kind).toBe('wall-clock');
    budget.dispose();
  });

  it('checkWallClock is inert when no wall-clock ceiling is configured', () => {
    let now = 0;
    const budget = new SpellRunBudget({ maxModelInvocations: 1 }, { now: () => now });
    now = 10_000_000;
    budget.checkWallClock();
    expect(budget.breach).toBeNull();
    budget.dispose();
  });

  it('does not overwrite an already-latched invocation breach', () => {
    let now = 0;
    const budget = new SpellRunBudget(
      { maxModelInvocations: 1, maxWallClockMs: 100 },
      { now: () => now },
    );
    budget.tryConsumeModelInvocation();
    budget.tryConsumeModelInvocation();
    now = 5_000;
    budget.checkWallClock();

    // First breach wins — it is the one that actually stopped the run.
    expect(budget.breach?.kind).toBe('model-invocations');
    budget.dispose();
  });

  it('fires from its own timer without anyone calling checkWallClock', async () => {
    const budget = new SpellRunBudget({ maxWallClockMs: 5 });
    await new Promise<void>((resolve) => {
      budget.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    expect(budget.breach?.kind).toBe('wall-clock');
    budget.dispose();
  });
});

describe('SpellRunBudget — signal composition', () => {
  it('aborts when the caller aborts, with no breach recorded', () => {
    const parent = new AbortController();
    const budget = new SpellRunBudget({ maxModelInvocations: 5 }, { parentSignal: parent.signal });

    parent.abort();

    expect(budget.signal.aborted).toBe(true);
    // A user cancellation is not a ceiling breach — conflating them would
    // report every ctrl-C as an overrun.
    expect(budget.breach).toBeNull();
    budget.dispose();
  });

  it('starts aborted when the caller already aborted', () => {
    const parent = new AbortController();
    parent.abort();
    const budget = new SpellRunBudget({ maxModelInvocations: 5 }, { parentSignal: parent.signal });

    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it('dispose detaches from the parent signal', () => {
    const parent = new AbortController();
    const budget = new SpellRunBudget({ maxWallClockMs: 60_000 }, { parentSignal: parent.signal });

    budget.dispose();
    parent.abort();

    expect(budget.signal.aborted).toBe(false);
  });

  it('dispose is idempotent', () => {
    const budget = new SpellRunBudget({ maxWallClockMs: 60_000 });
    expect(() => { budget.dispose(); budget.dispose(); }).not.toThrow();
  });
});
