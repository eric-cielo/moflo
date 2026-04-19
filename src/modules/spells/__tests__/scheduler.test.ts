/**
 * Scheduler Tests
 *
 * Tests for cron parsing, interval parsing, schedule validation,
 * next-run computation, and SpellScheduler lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseCron,
  parseInterval,
  parseAt,
  computeNextRun,
  nextRunFromCron,
  nextRunFromInterval,
  nextRunFromAt,
  validateSchedule,
} from '../src/scheduler/cron-parser.js';
import { SpellScheduler } from '../src/scheduler/scheduler.js';
import type { SpellExecutor, SchedulerEvent } from '../src/scheduler/scheduler.js';
import type { MemoryAccessor } from '../src/types/step-command.types.js';
import type { SpellResult } from '../src/types/runner.types.js';

// ============================================================================
// parseInterval
// ============================================================================

describe('parseInterval', () => {
  it('parses seconds', () => {
    expect(parseInterval('90s')).toBe(90_000);
  });

  it('parses minutes', () => {
    expect(parseInterval('30m')).toBe(1_800_000);
  });

  it('parses hours', () => {
    expect(parseInterval('6h')).toBe(21_600_000);
  });

  it('parses days', () => {
    expect(parseInterval('1d')).toBe(86_400_000);
  });

  it('returns null for invalid format', () => {
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('')).toBeNull();
    expect(parseInterval('10')).toBeNull();
    expect(parseInterval('10w')).toBeNull();
  });

  it('returns null for zero value', () => {
    expect(parseInterval('0h')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseInterval('  5m  ')).toBe(300_000);
  });
});

// ============================================================================
// parseAt
// ============================================================================

describe('parseAt', () => {
  it('parses ISO 8601 datetime', () => {
    const ts = parseAt('2026-04-01T09:00:00Z');
    expect(ts).toBe(Date.parse('2026-04-01T09:00:00Z'));
  });

  it('parses date without time', () => {
    const ts = parseAt('2026-04-01');
    expect(ts).not.toBeNull();
  });

  it('returns null for invalid date', () => {
    expect(parseAt('not-a-date')).toBeNull();
    expect(parseAt('')).toBeNull();
  });
});

// ============================================================================
// parseCron
// ============================================================================

describe('parseCron', () => {
  it('parses every-minute cron', () => {
    const parsed = parseCron('* * * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.minutes.size).toBe(60);
    expect(parsed!.hours.size).toBe(24);
  });

  it('parses specific time cron', () => {
    const parsed = parseCron('0 2 * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.minutes).toEqual(new Set([0]));
    expect(parsed!.hours).toEqual(new Set([2]));
  });

  it('parses step notation', () => {
    const parsed = parseCron('*/15 * * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it('parses range notation', () => {
    const parsed = parseCron('0 9-17 * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
  });

  it('parses list notation', () => {
    const parsed = parseCron('0 0 * * 1,3,5');
    expect(parsed).not.toBeNull();
    expect(parsed!.daysOfWeek).toEqual(new Set([1, 3, 5]));
  });

  it('parses range with step', () => {
    const parsed = parseCron('0-30/10 * * * *');
    expect(parsed).not.toBeNull();
    expect(parsed!.minutes).toEqual(new Set([0, 10, 20, 30]));
  });

  it('returns null for invalid field count', () => {
    expect(parseCron('* * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
  });

  it('returns null for out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('* 25 * * *')).toBeNull();
    expect(parseCron('* * 32 * *')).toBeNull();
    expect(parseCron('* * * 13 *')).toBeNull();
    expect(parseCron('* * * * 7')).toBeNull();
  });

  it('returns null for invalid range', () => {
    expect(parseCron('5-2 * * * *')).toBeNull(); // start > end
  });
});

// ============================================================================
// nextRunFromCron
// ============================================================================

describe('nextRunFromCron', () => {
  it('finds the next minute for every-minute cron', () => {
    const cron = parseCron('* * * * *')!;
    const now = new Date('2026-03-28T10:30:45Z').getTime();
    const next = nextRunFromCron(cron, now);
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getUTCMinutes()).toBe(31);
    expect(nextDate.getUTCSeconds()).toBe(0);
  });

  it('finds next 2 AM for daily cron', () => {
    const cron = parseCron('0 2 * * *')!;
    // Use local time: 3 AM today → next match is 2 AM tomorrow
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    const next = nextRunFromCron(cron, now.getTime());
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getHours()).toBe(2);
    expect(nextDate.getMinutes()).toBe(0);
    // Should be next day since 2 AM already passed (use time delta to handle month boundaries)
    const expectedTomorrow = new Date(now);
    expectedTomorrow.setDate(expectedTomorrow.getDate() + 1);
    expect(nextDate.getDate()).toBe(expectedTomorrow.getDate());
  });

  it('finds next matching day of week', () => {
    const cron = parseCron('0 0 * * 1')!; // Monday
    const now = new Date('2026-03-28T00:00:00Z').getTime(); // Saturday
    const next = nextRunFromCron(cron, now);
    expect(next).not.toBeNull();
    expect(new Date(next!).getUTCDay()).toBe(1); // Monday
  });
});

// ============================================================================
// nextRunFromInterval
// ============================================================================

describe('nextRunFromInterval', () => {
  it('returns now when no lastRunAt', () => {
    const now = Date.now();
    expect(nextRunFromInterval(3600_000, undefined, now)).toBe(now);
  });

  it('returns lastRunAt + interval when in the future', () => {
    const now = 1000;
    expect(nextRunFromInterval(500, 800, now)).toBe(1300);
  });

  it('returns now when next run is past due', () => {
    const now = 2000;
    expect(nextRunFromInterval(500, 100, now)).toBe(now);
  });
});

// ============================================================================
// nextRunFromAt
// ============================================================================

describe('nextRunFromAt', () => {
  it('returns timestamp when not yet run', () => {
    const at = Date.parse('2026-04-01T09:00:00Z');
    expect(nextRunFromAt(at, undefined)).toBe(at);
  });

  it('returns null when already run', () => {
    const at = Date.parse('2026-04-01T09:00:00Z');
    expect(nextRunFromAt(at, Date.now())).toBeNull();
  });
});

// ============================================================================
// computeNextRun
// ============================================================================

describe('computeNextRun', () => {
  it('computes next run from cron', () => {
    // Use local time: set to 1 AM so noon is in the future
    const now = new Date();
    now.setHours(1, 0, 0, 0);
    const next = computeNextRun({ cron: '0 12 * * *' }, now.getTime());
    expect(next).not.toBeNull();
    expect(new Date(next!).getHours()).toBe(12);
  });

  it('computes next run from interval', () => {
    const now = 10_000;
    const next = computeNextRun({ interval: '1h', lastRunAt: 5_000 }, now);
    // 5000 + 3600000 = 3605000, which is in the future relative to now=10000
    expect(next).toBe(3_605_000);
  });

  it('computes next run from at', () => {
    const at = '2026-04-01T09:00:00Z';
    const next = computeNextRun({ at });
    expect(next).toBe(Date.parse(at));
  });

  it('returns null for invalid cron', () => {
    expect(computeNextRun({ cron: 'bad' })).toBeNull();
  });

  it('returns null for invalid interval', () => {
    expect(computeNextRun({ interval: 'bad' })).toBeNull();
  });

  it('returns null when no schedule type specified', () => {
    expect(computeNextRun({})).toBeNull();
  });
});

// ============================================================================
// validateSchedule
// ============================================================================

describe('validateSchedule', () => {
  it('accepts valid cron schedule', () => {
    const errors = validateSchedule({ cron: '0 2 * * *' }, 'schedule');
    expect(errors).toHaveLength(0);
  });

  it('accepts valid interval schedule', () => {
    const errors = validateSchedule({ interval: '6h' }, 'schedule');
    expect(errors).toHaveLength(0);
  });

  it('accepts valid at schedule', () => {
    const errors = validateSchedule({ at: '2026-04-01T09:00:00Z' }, 'schedule');
    expect(errors).toHaveLength(0);
  });

  it('rejects empty schedule (no cron/interval/at)', () => {
    const errors = validateSchedule({}, 'schedule');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('exactly one of');
  });

  it('rejects multiple schedule types', () => {
    const errors = validateSchedule({ cron: '* * * * *', interval: '1h' }, 'schedule');
    expect(errors.some(e => e.message.includes('found multiple'))).toBe(true);
  });

  it('rejects invalid cron', () => {
    const errors = validateSchedule({ cron: 'bad' }, 'schedule');
    expect(errors.some(e => e.path === 'schedule.cron')).toBe(true);
  });

  it('rejects invalid interval', () => {
    const errors = validateSchedule({ interval: 'bad' }, 'schedule');
    expect(errors.some(e => e.path === 'schedule.interval')).toBe(true);
  });

  it('rejects invalid at', () => {
    const errors = validateSchedule({ at: 'not-a-date' }, 'schedule');
    expect(errors.some(e => e.path === 'schedule.at')).toBe(true);
  });

  it('rejects non-boolean enabled', () => {
    const errors = validateSchedule({ cron: '* * * * *', enabled: 'yes' as unknown as boolean }, 'schedule');
    expect(errors.some(e => e.path === 'schedule.enabled')).toBe(true);
  });
});

// ============================================================================
// Spell Definition with schedule block (validator integration)
// ============================================================================

describe('validateSpellDefinition with schedule', () => {
  // Lazy import to avoid circular dependency issues in test setup
  let validateSpellDefinition: typeof import('../src/schema/validator.js').validateSpellDefinition;

  beforeEach(async () => {
    const mod = await import('../src/schema/validator.js');
    validateSpellDefinition = mod.validateSpellDefinition;
  });

  it('accepts spell with valid cron schedule', () => {
    const result = validateSpellDefinition({
      name: 'nightly-audit',
      steps: [{ id: 's1', type: 'bash', config: { command: 'echo hi' } }],
      schedule: { cron: '0 2 * * *' },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts spell without schedule', () => {
    const result = validateSpellDefinition({
      name: 'manual-wf',
      steps: [{ id: 's1', type: 'bash', config: { command: 'echo hi' } }],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects spell with invalid schedule', () => {
    const result = validateSpellDefinition({
      name: 'bad-schedule',
      steps: [{ id: 's1', type: 'bash', config: { command: 'echo hi' } }],
      schedule: { cron: 'invalid' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path.startsWith('schedule'))).toBe(true);
  });
});

// ============================================================================
// SpellScheduler
// ============================================================================

describe('SpellScheduler', () => {
  let memory: MemoryAccessor;
  let executor: SpellExecutor;
  let scheduler: SpellScheduler;
  let store: Map<string, Map<string, unknown>>;

  function makeSuccessResult(): SpellResult {
    return {
      spellId: 'wf-1',
      success: true,
      steps: [],
      outputs: {},
      errors: [],
      duration: 100,
      cancelled: false,
    };
  }

  function makeFailResult(): SpellResult {
    return {
      spellId: 'wf-1',
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'STEP_EXECUTION_FAILED', message: 'step failed' }],
      duration: 50,
      cancelled: false,
    };
  }

  beforeEach(() => {
    store = new Map();

    memory = {
      async read(namespace: string, key: string) {
        return store.get(namespace)?.get(key) ?? null;
      },
      async write(namespace: string, key: string, value: unknown) {
        if (!store.has(namespace)) store.set(namespace, new Map());
        store.get(namespace)!.set(key, value);
      },
      async search(namespace: string) {
        const ns = store.get(namespace);
        if (!ns) return [];
        return [...ns.entries()].map(([key, value]) => ({ key, value, score: 1 }));
      },
    };

    executor = {
      execute: vi.fn().mockResolvedValue(makeSuccessResult()),
      exists: vi.fn().mockReturnValue(true),
    };

    scheduler = new SpellScheduler(memory, executor, {
      pollIntervalMs: 100,
      maxConcurrent: 2,
      catchUpWindowMs: 3_600_000,
    });
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  it('starts and stops', () => {
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('does not start twice', () => {
    scheduler.start();
    scheduler.start(); // should be a no-op
    expect(scheduler.isRunning).toBe(true);
  });

  // ── Schedule CRUD ──────────────────────────────────────────────────────

  it('creates an ad-hoc schedule', async () => {
    const schedule = await scheduler.createSchedule({
      spellName: 'test-wf',
      spellPath: '/spells/test.yaml',
      interval: '1h',
    });

    expect(schedule.id).toMatch(/^sched-adhoc-/);
    expect(schedule.spellName).toBe('test-wf');
    expect(schedule.enabled).toBe(true);
    expect(schedule.source).toBe('adhoc');
  });

  it('registers from spell definition', async () => {
    const definition = {
      name: 'nightly-audit',
      steps: [{ id: 's1', type: 'bash', config: { command: 'echo hi' } }],
      schedule: { cron: '0 2 * * *' },
    };

    const schedule = await scheduler.registerFromDefinition(definition, '/spells/nightly.yaml');
    expect(schedule).not.toBeNull();
    expect(schedule!.id).toBe('sched-def-nightly-audit');
    expect(schedule!.source).toBe('definition');
    expect(schedule!.cron).toBe('0 2 * * *');
  });

  it('returns null when definition has no schedule', async () => {
    const definition = {
      name: 'manual-wf',
      steps: [{ id: 's1', type: 'bash', config: { command: 'echo hi' } }],
    };

    const schedule = await scheduler.registerFromDefinition(definition, '/spells/manual.yaml');
    expect(schedule).toBeNull();
  });

  it('cancels a schedule', async () => {
    await scheduler.createSchedule({
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
    });

    const schedules = await scheduler.listSchedules();
    expect(schedules).toHaveLength(1);

    const cancelled = await scheduler.cancelSchedule(schedules[0].id);
    expect(cancelled).toBe(true);

    const updated = await scheduler.getSchedule(schedules[0].id);
    expect(updated!.enabled).toBe(false);
  });

  it('returns false when cancelling non-existent schedule', async () => {
    const cancelled = await scheduler.cancelSchedule('nonexistent');
    expect(cancelled).toBe(false);
  });

  it('lists all schedules', async () => {
    await scheduler.createSchedule({ spellName: 'wf1', spellPath: '/p1', interval: '1h' });
    await scheduler.createSchedule({ spellName: 'wf2', spellPath: '/p2', cron: '0 * * * *' });

    const schedules = await scheduler.listSchedules();
    expect(schedules).toHaveLength(2);
  });

  // ── Polling & Execution ───────────��────────────────────────────────────

  it('executes a due spell on poll', async () => {
    // Create a schedule that is already due
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-test', {
      id: 'sched-test',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000, // already due
      enabled: true,
      createdAt: now - 3600_000,
      source: 'adhoc',
    });

    await scheduler.poll();

    expect(executor.execute).toHaveBeenCalledWith('test-wf', {}, expect.any(AbortSignal), undefined);
  });

  it('skips disabled schedules', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-disabled', {
      id: 'sched-disabled',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: false,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();

    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('skips schedules not yet due', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-future', {
      id: 'sched-future',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now + 60_000, // 1 minute in the future
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();

    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('disables schedule when spell no longer exists', async () => {
    (executor.exists as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-deleted', {
      id: 'sched-deleted',
      spellName: 'deleted-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();

    expect(executor.execute).not.toHaveBeenCalled();
    const updated = await scheduler.getSchedule('sched-deleted');
    expect(updated!.enabled).toBe(false);
  });

  it('fires a missed schedule within the catch-up window and emits schedule:catchup', async () => {
    const events: SchedulerEvent[] = [];
    scheduler.on(e => events.push(e));

    // 30 minutes ago — well inside the 1h default catch-up window
    const lagMs = 30 * 60 * 1000;
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-catchup', {
      id: 'sched-catchup',
      spellName: 'catchup-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - lagMs,
      enabled: true,
      createdAt: now - 86_400_000,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executor.execute).toHaveBeenCalledTimes(1);

    const types = events.map(e => e.type);
    expect(types).toContain('schedule:catchup');
    expect(types).toContain('schedule:due');
    expect(types).toContain('schedule:completed');

    // History record reflects the catch-up fire
    const history = await scheduler.getExecutionHistory('sched-catchup');
    expect(history).toHaveLength(1);
    expect(history[0].success).toBe(true);
  });

  it('does not emit schedule:catchup for an exactly-on-time fire', async () => {
    const events: SchedulerEvent[] = [];
    scheduler.on(e => events.push(e));

    // nextRunAt set exactly to "now" — no lag, not a catch-up
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-ontime', {
      id: 'sched-ontime',
      spellName: 'ontime-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(events.some(e => e.type === 'schedule:catchup')).toBe(false);
    expect(events.some(e => e.type === 'schedule:due')).toBe(true);
  });

  it('skips expired catch-up runs', async () => {
    const events: SchedulerEvent[] = [];
    scheduler.on(e => events.push(e));

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-old', {
      id: 'sched-old',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 7_200_000, // 2 hours ago — exceeds 1h catch-up window
      enabled: true,
      createdAt: now - 86_400_000,
      source: 'adhoc',
    });

    await scheduler.poll();

    expect(executor.execute).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'schedule:skipped')).toBe(true);
  });

  it('prevents overlapping executions', async () => {
    // Make executor hang
    let resolveExecution: () => void;
    (executor.execute as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SpellResult>(resolve => {
        resolveExecution = () => resolve(makeSuccessResult());
      }),
    );

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-overlap', {
      id: 'sched-overlap',
      spellName: 'slow-wf',
      spellPath: '/path',
      interval: '1m',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    // First poll starts execution
    await scheduler.poll();
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Second poll should skip because first is still running
    await scheduler.poll();
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Resolve the first execution
    resolveExecution!();
    // Wait for the async execution to complete
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('respects maxConcurrent limit', async () => {
    let resolvers: Array<() => void> = [];
    (executor.execute as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SpellResult>(resolve => {
        resolvers.push(() => resolve(makeSuccessResult()));
      }),
    );

    const now = Date.now();
    // Create 3 due schedules, but maxConcurrent is 2
    for (let i = 0; i < 3; i++) {
      await memory.write('scheduled-spells', `sched-${i}`, {
        id: `sched-${i}`,
        spellName: `wf-${i}`,
        spellPath: '/path',
        interval: '1h',
        nextRunAt: now - 1000,
        enabled: true,
        createdAt: now,
        source: 'adhoc',
      });
    }

    await scheduler.poll();

    // Only 2 should have been started
    expect(executor.execute).toHaveBeenCalledTimes(2);

    // Resolve them
    for (const r of resolvers) r();
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  // ── Events ─────────────────────────────────────────────────────────────

  it('emits events during execution', async () => {
    const events: SchedulerEvent[] = [];
    scheduler.on(e => events.push(e));

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-events', {
      id: 'sched-events',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();
    // Wait for async execution
    await new Promise(resolve => setTimeout(resolve, 50));

    const types = events.map(e => e.type);
    expect(types).toContain('schedule:due');
    expect(types).toContain('schedule:started');
    expect(types).toContain('schedule:completed');
  });

  it('emits failed event on execution error', async () => {
    (executor.execute as ReturnType<typeof vi.fn>).mockResolvedValue(makeFailResult());

    const events: SchedulerEvent[] = [];
    scheduler.on(e => events.push(e));

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-fail', {
      id: 'sched-fail',
      spellName: 'fail-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(events.some(e => e.type === 'schedule:failed')).toBe(true);
  });

  it('unsubscribes event listener', () => {
    const events: SchedulerEvent[] = [];
    const unsub = scheduler.on(e => events.push(e));
    unsub();

    // No events should be captured after unsub
    scheduler['emit']({
      type: 'schedule:due',
      scheduleId: 'test',
      spellName: 'test',
      message: 'test',
      timestamp: Date.now(),
    });
    expect(events).toHaveLength(0);
  });

  // ── One-time (at) schedules ────────────────────────────────────────────

  it('auto-disables one-time schedule after execution', async () => {
    const future = Date.now() - 1000; // already due
    await memory.write('scheduled-spells', 'sched-once', {
      id: 'sched-once',
      spellName: 'once-wf',
      spellPath: '/path',
      at: new Date(future).toISOString(),
      nextRunAt: future,
      enabled: true,
      createdAt: Date.now() - 10_000,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    const updated = await scheduler.getSchedule('sched-once');
    expect(updated!.enabled).toBe(false);
  });

  // ── Execution history ────────────���─────────────────────────────────────

  it('stores execution history', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-hist', {
      id: 'sched-hist',
      spellName: 'hist-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    const history = await scheduler.getExecutionHistory('sched-hist');
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].scheduleId).toBe('sched-hist');
    expect(history[0].success).toBe(true);
  });

  // ── End-to-end integration ─────────────────────────────────────────────

  it('end-to-end: createSchedule → make due → poll → execute → history written', async () => {
    // 1. Create a fresh schedule via the public API (no manual memory writes)
    const created = await scheduler.createSchedule({
      spellName: 'integration-wf',
      spellPath: '/spells/integration.yaml',
      interval: '1h',
      args: { mode: 'audit' },
    });

    expect(created.enabled).toBe(true);

    // 2. Force the schedule to be due by rewriting only `nextRunAt`. We avoid
    //    sleeping for the real interval so the test stays fast and deterministic.
    const stored = await scheduler.getSchedule(created.id);
    await memory.write('scheduled-spells', created.id, { ...stored, nextRunAt: Date.now() - 100 });

    // 3. Tick the scheduler once
    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    // 4. Verify the spell executed with the correct args
    expect(executor.execute).toHaveBeenCalledWith(
      'integration-wf', { mode: 'audit' }, expect.any(AbortSignal), undefined,
    );

    // 5. Verify history record persisted with success
    const history = await scheduler.getExecutionHistory(created.id);
    expect(history).toHaveLength(1);
    expect(history[0].success).toBe(true);
    expect(history[0].spellName).toBe('integration-wf');
    expect(history[0].duration).toBeGreaterThanOrEqual(0);

    // 6. Verify nextRunAt advanced past now (so it doesn't fire again immediately)
    const after = await scheduler.getSchedule(created.id);
    expect(after!.nextRunAt).toBeGreaterThan(Date.now());
    expect(after!.lastRunAt).toBeDefined();
  });

  // ── MoFlo Level Caps (Issue #185) ──────────────────────────────────────

  it('passes maxMofloLevel to executor when set on scheduler', async () => {
    const cappedScheduler = new SpellScheduler(memory, executor, {
      pollIntervalMs: 100,
      maxConcurrent: 2,
      maxMofloLevel: 'hooks',
    });

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-capped', {
      id: 'sched-capped',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await cappedScheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executor.execute).toHaveBeenCalledWith(
      'test-wf', {}, expect.any(AbortSignal), 'hooks',
    );

    await cappedScheduler.stop();
  });

  it('per-schedule mofloLevel narrows scheduler-level cap', async () => {
    const cappedScheduler = new SpellScheduler(memory, executor, {
      pollIntervalMs: 100,
      maxConcurrent: 2,
      maxMofloLevel: 'full',
    });

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-narrow', {
      id: 'sched-narrow',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      mofloLevel: 'memory',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await cappedScheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executor.execute).toHaveBeenCalledWith(
      'test-wf', {}, expect.any(AbortSignal), 'memory',
    );

    await cappedScheduler.stop();
  });

  it('per-schedule mofloLevel cannot widen scheduler-level cap', async () => {
    const cappedScheduler = new SpellScheduler(memory, executor, {
      pollIntervalMs: 100,
      maxConcurrent: 2,
      maxMofloLevel: 'memory',
    });

    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-widen', {
      id: 'sched-widen',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      mofloLevel: 'full',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await cappedScheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executor.execute).toHaveBeenCalledWith(
      'test-wf', {}, expect.any(AbortSignal), 'memory',
    );

    await cappedScheduler.stop();
  });

  it('passes undefined mofloLevel when no caps are set (default behavior)', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-nocp', {
      id: 'sched-nocp',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executor.execute).toHaveBeenCalledWith(
      'test-wf', {}, expect.any(AbortSignal), undefined,
    );
  });

  it('uses only per-schedule cap when no scheduler-level cap exists', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-only', {
      id: 'sched-only',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      mofloLevel: 'hooks',
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(executor.execute).toHaveBeenCalledWith(
      'test-wf', {}, expect.any(AbortSignal), 'hooks',
    );
  });

  // ── Args passing ─────────────────���─────────────────────────────────────

  it('passes args to spell executor', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-args', {
      id: 'sched-args',
      spellName: 'args-wf',
      spellPath: '/path',
      interval: '1h',
      args: { target: './src' },
      nextRunAt: now - 1000,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.poll();

    expect(executor.execute).toHaveBeenCalledWith('args-wf', { target: './src' }, expect.any(AbortSignal), undefined);
  });

  // ── getRecentExecutions ────────────────────────────────────────────────

  it('getRecentExecutions merges executions across all schedules, newest first', async () => {
    const now = Date.now();
    await memory.write('schedule-executions', 'exec-1', {
      id: 'exec-1', scheduleId: 'sched-a', spellName: 'a', startedAt: now - 3000, success: true,
    });
    await memory.write('schedule-executions', 'exec-2', {
      id: 'exec-2', scheduleId: 'sched-b', spellName: 'b', startedAt: now - 1000, success: false,
    });
    await memory.write('schedule-executions', 'exec-3', {
      id: 'exec-3', scheduleId: 'sched-a', spellName: 'a', startedAt: now - 2000, success: true, manualRun: true,
    });

    const recent = await scheduler.getRecentExecutions(10);
    expect(recent.map(e => e.id)).toEqual(['exec-2', 'exec-3', 'exec-1']);
    expect(recent[1].manualRun).toBe(true);
  });

  it('getRecentExecutions respects limit', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await memory.write('schedule-executions', `exec-${i}`, {
        id: `exec-${i}`, scheduleId: 'sched-x', spellName: 'x', startedAt: now - i * 100, success: true,
      });
    }
    const recent = await scheduler.getRecentExecutions(3);
    expect(recent).toHaveLength(3);
  });

  // ── Dashboard story #447: runScheduleNow + enableSchedule ──────────────

  it('runScheduleNow writes a manual-marked execution record', async () => {
    const now = Date.now();
    await memory.write('scheduled-spells', 'sched-manual', {
      id: 'sched-manual',
      spellName: 'manual-wf',
      spellPath: '/path',
      interval: '6h',
      nextRunAt: now + 3_600_000, // an hour away — nothing would fire naturally
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    const exec = await scheduler.runScheduleNow('sched-manual');
    expect(exec.manualRun).toBe(true);
    expect(exec.success).toBe(true);
    expect(exec.id).toMatch(/^exec-manual-/);

    const history = await scheduler.getExecutionHistory('sched-manual');
    expect(history).toHaveLength(1);
    expect(history[0].manualRun).toBe(true);
  });

  it('runScheduleNow does NOT advance nextRunAt', async () => {
    const now = Date.now();
    const originalNextRun = now + 3_600_000;
    await memory.write('scheduled-spells', 'sched-noadvance', {
      id: 'sched-noadvance',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: originalNextRun,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    });

    await scheduler.runScheduleNow('sched-noadvance');

    const updated = await scheduler.getSchedule('sched-noadvance');
    expect(updated!.nextRunAt).toBe(originalNextRun); // unchanged
    expect(updated!.lastRunAt).toBeUndefined(); // manual runs don't claim the slot
  });

  it('runScheduleNow throws when schedule is unknown', async () => {
    await expect(scheduler.runScheduleNow('no-such-id')).rejects.toThrow(/not found/i);
  });

  it('runScheduleNow throws when spell no longer exists', async () => {
    (executor.exists as any).mockReturnValueOnce(false);
    await memory.write('scheduled-spells', 'sched-gone', {
      id: 'sched-gone',
      spellName: 'ghost-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: Date.now() + 1000,
      enabled: true,
      createdAt: Date.now(),
      source: 'adhoc',
    });
    await expect(scheduler.runScheduleNow('sched-gone')).rejects.toThrow(/no longer exists/i);
  });

  it('enableSchedule flips enabled=true and pushes nextRunAt forward', async () => {
    const past = Date.now() - 10 * 86_400_000; // 10 days ago — stale
    await memory.write('scheduled-spells', 'sched-reenable', {
      id: 'sched-reenable',
      spellName: 'test-wf',
      spellPath: '/path',
      interval: '1h',
      nextRunAt: past,
      enabled: false,
      createdAt: past,
      source: 'adhoc',
    });

    const before = Date.now();
    const updated = await scheduler.enableSchedule('sched-reenable');

    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(true);
    expect(updated!.nextRunAt).toBeGreaterThanOrEqual(before);
  });

  it('enableSchedule returns null for unknown schedule', async () => {
    const result = await scheduler.enableSchedule('no-such-id');
    expect(result).toBeNull();
  });

  it('enableSchedule returns null for expired one-time (at) schedule', async () => {
    const past = Date.now() - 86_400_000;
    await memory.write('scheduled-spells', 'sched-at-expired', {
      id: 'sched-at-expired',
      spellName: 'test-wf',
      spellPath: '/path',
      at: new Date(past).toISOString(),
      nextRunAt: past,
      enabled: false,
      createdAt: past,
      source: 'adhoc',
    });

    const result = await scheduler.enableSchedule('sched-at-expired');
    expect(result).toBeNull();
  });
});
