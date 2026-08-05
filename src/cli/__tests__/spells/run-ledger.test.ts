/**
 * Rolling-window invocation ledger tests.
 *
 * The per-run ceiling from #1335 is unit-tested in run-budget.test.ts. What
 * matters here is the property that ceiling could not have: a count that
 * OUTLIVES the run, so a schedule firing every five minutes cannot satisfy a
 * per-run ceiling thousands of times a day.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  InvocationLedger,
  ledgerPathFor,
  LEDGER_WINDOW_MS,
} from '../../spells/core/run-ledger.js';
import {
  createRunBudget,
  mergeSpellBudgets,
  resolveSpellBudgetConfig,
  hasBudgetLimit,
} from '../../spells/core/run-budget.js';
import { validateBudget } from '../../spells/schema/validators/top-level.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import type { ValidationError } from '../../spells/types/step-command.types.js';

const HOUR = 60 * 60 * 1000;

describe('InvocationLedger', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'moflo-ledger-'));
    path = ledgerPathFor(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts empty when no file exists', () => {
    expect(new InvocationLedger(path).count()).toBe(0);
  });

  it('counts what it records', () => {
    const ledger = new InvocationLedger(path);
    ledger.record();
    ledger.record();
    ledger.record();
    expect(ledger.count()).toBe(3);
  });

  it('persists across instances — the whole point of the ledger', () => {
    new InvocationLedger(path).record();
    new InvocationLedger(path).record();
    // A fresh instance, as a later scheduled run would construct.
    expect(new InvocationLedger(path).count()).toBe(2);
  });

  it('creates .moflo/ when it does not exist yet', () => {
    expect(existsSync(dirname(path))).toBe(false);
    new InvocationLedger(path).record();
    expect(existsSync(path)).toBe(true);
  });

  it('drops invocations that fell out of the trailing window', () => {
    let now = Date.UTC(2026, 0, 2, 12, 0, 0);
    const ledger = new InvocationLedger(path, { now: () => now });
    ledger.record();
    ledger.record();
    expect(ledger.count()).toBe(2);

    now += LEDGER_WINDOW_MS + HOUR;
    expect(ledger.count()).toBe(0);
  });

  it('keeps invocations still inside the window', () => {
    let now = Date.UTC(2026, 0, 2, 12, 0, 0);
    const ledger = new InvocationLedger(path, { now: () => now });
    ledger.record();

    now += 20 * HOUR; // still under 24h
    ledger.record();
    expect(ledger.count()).toBe(2);
  });

  it('prunes on write so the file cannot grow without bound', () => {
    let now = Date.UTC(2026, 0, 2, 0, 0, 0);
    const ledger = new InvocationLedger(path, { now: () => now });
    // 100 hours of activity — only ~24 buckets may survive.
    for (let i = 0; i < 100; i++) {
      ledger.record();
      now += HOUR;
    }
    const buckets = JSON.parse(readFileSync(path, 'utf-8')).buckets as Record<string, number>;
    expect(Object.keys(buckets).length).toBeLessThanOrEqual(25);
  });

  it('reports remaining against a limit', () => {
    const ledger = new InvocationLedger(path);
    ledger.record();
    ledger.record();
    expect(ledger.remaining(5)).toBe(3);
    expect(ledger.remaining(1)).toBe(0);
  });

  it('fails open on a corrupt file rather than blocking every run', () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf-8');
    const ledger = new InvocationLedger(path);
    expect(ledger.count()).toBe(0);
    ledger.record();
    expect(ledger.count()).toBe(1);
  });

  it('fails open on a ledger written by a future version', () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99, buckets: { '1': 500 } }), 'utf-8');
    expect(new InvocationLedger(path).count()).toBe(0);
  });

  it('ignores non-numeric bucket values instead of producing NaN', () => {
    mkdirSync(dirname(path), { recursive: true });
    const bucket = String(Math.floor(Date.now() / HOUR));
    writeFileSync(
      path,
      JSON.stringify({ version: 1, buckets: { [bucket]: 2, junk: 'x' } }),
      'utf-8',
    );
    expect(new InvocationLedger(path).count()).toBe(2);
  });

  it('does not throw when the path is unwritable', () => {
    // A directory where the file should be — write fails, record swallows it.
    mkdirSync(path, { recursive: true });
    expect(() => new InvocationLedger(path).record()).not.toThrow();
  });
});

describe('ledgerPathFor', () => {
  it('places the ledger under .moflo/ in the project root', () => {
    const p = ledgerPathFor(join('a', 'b'));
    expect(p).toBe(join('a', 'b', '.moflo', 'spell-invocation-ledger.json'));
  });
});

// ============================================================================
// Daily ceiling on the budget
// ============================================================================

describe('SpellRunBudget — daily ceiling', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'moflo-daily-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('denies once the rolling window is spent', () => {
    const budget = createRunBudget({ dailyModelInvocations: 2 }, { ledgerDir: root })!;
    expect(budget.tryConsumeModelInvocation()).toBe(true);
    expect(budget.tryConsumeModelInvocation()).toBe(true);
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    expect(budget.breach?.kind).toBe('daily-model-invocations');
    expect(budget.breach?.limit).toBe(2);
  });

  it('carries the spend across runs — a second run inherits the first run\'s count', () => {
    const first = createRunBudget({ dailyModelInvocations: 3 }, { ledgerDir: root })!;
    first.tryConsumeModelInvocation();
    first.tryConsumeModelInvocation();
    first.dispose();

    // A separate run, as the next scheduled fire would be.
    const second = createRunBudget({ dailyModelInvocations: 3 }, { ledgerDir: root })!;
    expect(second.tryConsumeModelInvocation()).toBe(true);
    expect(second.tryConsumeModelInvocation()).toBe(false);
    expect(second.breach?.kind).toBe('daily-model-invocations');
    expect(second.breach?.observed).toBe(3);
  });

  it('does NOT abort the signal on a daily breach — the runner owns the stop', () => {
    const budget = createRunBudget({ dailyModelInvocations: 1 }, { ledgerDir: root })!;
    budget.tryConsumeModelInvocation();
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    expect(budget.signal.aborted).toBe(false);
  });

  it('is inert without a ledger directory, leaving per-run ceilings intact', () => {
    const budget = createRunBudget({ dailyModelInvocations: 1, maxModelInvocations: 2 })!;
    expect(budget.tryConsumeModelInvocation()).toBe(true);
    expect(budget.tryConsumeModelInvocation()).toBe(true);
    // Stopped by the per-run ceiling, not the (unenforceable) daily one.
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    expect(budget.breach?.kind).toBe('model-invocations');
  });

  it('reports the daily ceiling first when both are exhausted', () => {
    const ledger = new InvocationLedger(ledgerPathFor(root));
    ledger.record();
    ledger.record();

    const budget = createRunBudget(
      { dailyModelInvocations: 2, maxModelInvocations: 5 },
      { ledgerDir: root },
    )!;
    expect(budget.tryConsumeModelInvocation()).toBe(false);
    expect(budget.breach?.kind).toBe('daily-model-invocations');
  });

  it('records to the ledger only for invocations it actually granted', () => {
    const budget = createRunBudget(
      { maxModelInvocations: 1, dailyModelInvocations: 10 },
      { ledgerDir: root },
    )!;
    budget.tryConsumeModelInvocation();          // granted
    budget.tryConsumeModelInvocation();          // denied by the per-run ceiling
    expect(new InvocationLedger(ledgerPathFor(root)).count()).toBe(1);
  });

  it('does not touch the ledger when no daily ceiling is configured', () => {
    const budget = createRunBudget({ maxModelInvocations: 5 }, { ledgerDir: root })!;
    budget.tryConsumeModelInvocation();
    expect(existsSync(ledgerPathFor(root))).toBe(false);
  });
});

// ============================================================================
// Config plumbing
// ============================================================================

describe('dailyModelInvocations config', () => {
  it('is enough on its own to constitute a budget', () => {
    expect(hasBudgetLimit({ dailyModelInvocations: 5 })).toBe(true);
    expect(createRunBudget({ dailyModelInvocations: 5 })).not.toBeNull();
  });

  it('parses from camelCase and snake_case', () => {
    expect(resolveSpellBudgetConfig({ dailyModelInvocations: 7 }))
      .toEqual({ dailyModelInvocations: 7 });
    expect(resolveSpellBudgetConfig({ daily_model_invocations: 7 }))
      .toEqual({ dailyModelInvocations: 7 });
  });

  it('drops a non-positive value rather than clamping it', () => {
    expect(resolveSpellBudgetConfig({ dailyModelInvocations: 0 })).toBeUndefined();
    expect(resolveSpellBudgetConfig({ dailyModelInvocations: -3 })).toBeUndefined();
  });

  it('merges under most-strict-wins', () => {
    expect(mergeSpellBudgets(
      { dailyModelInvocations: 100 },
      { dailyModelInvocations: 20 },
    )).toEqual({ dailyModelInvocations: 20 });
  });

  it('is accepted by the spell budget-block validator', () => {
    const errors: ValidationError[] = [];
    validateBudget({ budget: { dailyModelInvocations: 40 } } as unknown as SpellDefinition, errors);
    expect(errors).toEqual([]);
  });

  it('still rejects an unknown neighbouring key', () => {
    const errors: ValidationError[] = [];
    validateBudget({ budget: { dailyModelInvokations: 40 } } as unknown as SpellDefinition, errors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('dailyModelInvocations');
  });
});
