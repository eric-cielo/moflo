/**
 * Worker Daemon — Per-Worker Runtime Cap with Overrun Backoff (#631)
 *
 * Verifies the safety net that prevents any worker from queuing runs faster
 * than it finishes them: overrun detection, linear backoff, auto-disable
 * after sustained overruns, and round-trip persistence of the disabled state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('daemon-state.json') || filePath.includes('config.json'))) {
        return '{}';
      }
      throw new Error('ENOENT');
    }),
    appendFileSync: vi.fn(),
  };
});

vi.mock('../../services/headless-worker-executor.js', () => ({
  HeadlessWorkerExecutor: vi.fn().mockImplementation(() => ({
    isAvailable: vi.fn().mockResolvedValue(false),
    on: vi.fn(),
  })),
  HEADLESS_WORKER_TYPES: [],
  HEADLESS_WORKER_CONFIGS: {},
  isHeadlessWorker: vi.fn().mockReturnValue(false),
}));

const originalOn = process.on.bind(process);
vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
  if (['SIGTERM', 'SIGINT', 'SIGHUP'].includes(event)) return process;
  return originalOn(event, handler);
});

import { WorkerDaemon } from '../../services/worker-daemon.js';
import type { DaemonConfig } from '../../services/worker-daemon.js';

const INTERVAL_MS = 1000;
const FAST_RUN_MS = 100;        // well under overrun budget (2 × 1000 = 2000)
const SLOW_RUN_MS = 3000;       // > 2 × 1000 → overrun

function buildDaemon(extra: Partial<DaemonConfig> = {}): WorkerDaemon {
  return new WorkerDaemon('/tmp/test-overrun', {
    autoStart: false,
    workers: [
      { type: 'map', intervalMs: INTERVAL_MS, priority: 'normal', description: 'test', enabled: true },
    ],
    ...extra,
  });
}

/** Make `triggerWorker` produce a run of exactly `durationMs` by advancing the mocked Date.now(). */
function stubRun(daemon: WorkerDaemon, getNow: () => number, setNow: (n: number) => void, durationMs: number, succeed = true): void {
  vi.spyOn(daemon as unknown as { runWorkerLogic: (cfg: unknown) => Promise<unknown> }, 'runWorkerLogic')
    .mockImplementation(async () => {
      setNow(getNow() + durationMs);
      if (!succeed) throw new Error('forced failure');
      return { ok: true };
    });
}

describe('WorkerDaemon overrun handling (#631)', () => {
  let daemon: WorkerDaemon;
  let now = 0;

  beforeEach(() => {
    now = 1_000_000; // arbitrary epoch base
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Defaults
  // ===========================================================================
  describe('config defaults', () => {
    it('uses overrunMultiplier=2 and maxConsecutiveOverruns=3 when not overridden', () => {
      daemon = buildDaemon();
      const cfg = daemon.getStatus().config;
      expect(cfg.overrunMultiplier).toBe(2);
      expect(cfg.maxConsecutiveOverruns).toBe(3);
    });

    it('honours constructor overrides', () => {
      daemon = buildDaemon({ overrunMultiplier: 5, maxConsecutiveOverruns: 10 });
      const cfg = daemon.getStatus().config;
      expect(cfg.overrunMultiplier).toBe(5);
      expect(cfg.maxConsecutiveOverruns).toBe(10);
    });

    it('initializes state with consecutiveOverruns=0 and no disable flag', () => {
      daemon = buildDaemon();
      const state = daemon.getStatus().workers.get('map')!;
      expect(state.consecutiveOverruns).toBe(0);
      expect(state.disabledByOverrun).toBeUndefined();
      expect(state.lastDurationMs).toBeUndefined();
    });
  });

  // ===========================================================================
  // Detection + reset
  // ===========================================================================
  describe('overrun detection', () => {
    it('increments consecutiveOverruns when run exceeds intervalMs × overrunMultiplier', async () => {
      daemon = buildDaemon();
      stubRun(daemon, () => now, n => { now = n; }, SLOW_RUN_MS);

      await daemon.triggerWorker('map');

      const state = daemon.getStatus().workers.get('map')!;
      expect(state.lastDurationMs).toBe(SLOW_RUN_MS);
      expect(state.consecutiveOverruns).toBe(1);
      expect(state.disabledByOverrun).toBeUndefined();
    });

    it('resets consecutiveOverruns to 0 on a normal-duration run', async () => {
      daemon = buildDaemon();

      stubRun(daemon, () => now, n => { now = n; }, SLOW_RUN_MS);
      await daemon.triggerWorker('map');
      expect(daemon.getStatus().workers.get('map')!.consecutiveOverruns).toBe(1);

      vi.restoreAllMocks();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      stubRun(daemon, () => now, n => { now = n; }, FAST_RUN_MS);
      await daemon.triggerWorker('map');

      const state = daemon.getStatus().workers.get('map')!;
      expect(state.lastDurationMs).toBe(FAST_RUN_MS);
      expect(state.consecutiveOverruns).toBe(0);
    });

    it('still tracks overrun on failed runs', async () => {
      daemon = buildDaemon();
      stubRun(daemon, () => now, n => { now = n; }, SLOW_RUN_MS, /* succeed */ false);

      await daemon.triggerWorker('map');

      const state = daemon.getStatus().workers.get('map')!;
      expect(state.failureCount).toBe(1);
      expect(state.consecutiveOverruns).toBe(1);
    });
  });

  // ===========================================================================
  // Backoff math
  // ===========================================================================
  describe('linear backoff', () => {
    it('computeNextDelay returns intervalMs when no overruns', () => {
      daemon = buildDaemon();
      const cfg = { type: 'map', intervalMs: INTERVAL_MS, priority: 'normal', description: 'x', enabled: true };
      const state = { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0, isRunning: false, consecutiveOverruns: 0 };
      const delay = (daemon as unknown as { computeNextDelay: (c: unknown, s: unknown) => number }).computeNextDelay(cfg, state);
      expect(delay).toBe(INTERVAL_MS);
    });

    it('computeNextDelay scales linearly with consecutiveOverruns', () => {
      daemon = buildDaemon();
      const cfg = { type: 'map', intervalMs: INTERVAL_MS, priority: 'normal', description: 'x', enabled: true };
      const computeNextDelay = (daemon as unknown as { computeNextDelay: (c: unknown, s: unknown) => number }).computeNextDelay.bind(daemon);

      expect(computeNextDelay(cfg, { ...baseState(), consecutiveOverruns: 1 })).toBe(INTERVAL_MS * 2);
      expect(computeNextDelay(cfg, { ...baseState(), consecutiveOverruns: 2 })).toBe(INTERVAL_MS * 3);
    });

    it('computeNextDelay caps at MAX_OVERRUN_BACKOFF_MS (30 min)', () => {
      daemon = buildDaemon();
      const cfg = { type: 'map', intervalMs: 10 * 60 * 1000 /* 10 min */, priority: 'normal', description: 'x', enabled: true };
      const computeNextDelay = (daemon as unknown as { computeNextDelay: (c: unknown, s: unknown) => number }).computeNextDelay.bind(daemon);

      // 10 min × (1 + 5) = 60 min, should cap at 30 min
      const delay = computeNextDelay(cfg, { ...baseState(), consecutiveOverruns: 5 });
      expect(delay).toBe(30 * 60 * 1000);
    });
  });

  // ===========================================================================
  // Auto-disable
  // ===========================================================================
  describe('auto-disable on sustained overrun', () => {
    it('disables worker after maxConsecutiveOverruns and emits event', async () => {
      daemon = buildDaemon({ maxConsecutiveOverruns: 3 });
      const disabledHandler = vi.fn();
      daemon.on('worker:disabled-overrun', disabledHandler);

      for (let i = 0; i < 3; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        stubRun(daemon, () => now, n => { now = n; }, SLOW_RUN_MS);
        await daemon.triggerWorker('map');
      }

      const state = daemon.getStatus().workers.get('map')!;
      const cfg = daemon.getStatus().config.workers.find(w => w.type === 'map')!;
      expect(state.consecutiveOverruns).toBe(3);
      expect(state.disabledByOverrun).toBe(true);
      expect(cfg.enabled).toBe(false);
      expect(disabledHandler).toHaveBeenCalledTimes(1);
      expect(disabledHandler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'map',
        consecutiveOverruns: 3,
        lastDurationMs: SLOW_RUN_MS,
      }));
    });

    it('respects custom maxConsecutiveOverruns', async () => {
      daemon = buildDaemon({ maxConsecutiveOverruns: 2 });

      for (let i = 0; i < 2; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        stubRun(daemon, () => now, n => { now = n; }, SLOW_RUN_MS);
        await daemon.triggerWorker('map');
      }

      expect(daemon.getStatus().workers.get('map')!.disabledByOverrun).toBe(true);
    });
  });

  // ===========================================================================
  // No regression for healthy workers
  // ===========================================================================
  describe('healthy workers', () => {
    it('does not flag normal-duration runs no matter how many', async () => {
      daemon = buildDaemon();
      const disabledHandler = vi.fn();
      daemon.on('worker:disabled-overrun', disabledHandler);

      for (let i = 0; i < 10; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        stubRun(daemon, () => now, n => { now = n; }, FAST_RUN_MS);
        await daemon.triggerWorker('map');
      }

      const state = daemon.getStatus().workers.get('map')!;
      const cfg = daemon.getStatus().config.workers.find(w => w.type === 'map')!;
      expect(state.consecutiveOverruns).toBe(0);
      expect(state.disabledByOverrun).toBeUndefined();
      expect(cfg.enabled).toBe(true);
      expect(disabledHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Persistence round-trip
  // ===========================================================================
  describe('persistence', () => {
    it('round-trips disabledByOverrun + consecutiveOverruns through daemon-state.json', async () => {
      const savedState = JSON.stringify({
        running: false,
        workers: {
          map: {
            runCount: 5,
            successCount: 2,
            failureCount: 3,
            averageDurationMs: 2500,
            isRunning: false,
            lastDurationMs: 3500,
            consecutiveOverruns: 3,
            disabledByOverrun: true,
          },
        },
        config: {
          workers: [
            { type: 'map', intervalMs: INTERVAL_MS, priority: 'normal', description: 'test', enabled: false },
          ],
        },
      });

      vi.mocked(fs.readFileSync).mockImplementation((filePath: fs.PathOrFileDescriptor) => {
        if (typeof filePath === 'string' && filePath.includes('daemon-state.json')) return savedState;
        if (typeof filePath === 'string' && filePath.includes('config.json')) return '{}';
        throw new Error('ENOENT');
      });

      daemon = buildDaemon();
      const state = daemon.getStatus().workers.get('map')!;
      const cfg = daemon.getStatus().config.workers.find(w => w.type === 'map')!;

      expect(state.consecutiveOverruns).toBe(3);
      expect(state.lastDurationMs).toBe(3500);
      expect(state.disabledByOverrun).toBe(true);
      expect(cfg.enabled).toBe(false);
    });
  });
});

function baseState() {
  return {
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    averageDurationMs: 0,
    isRunning: false,
    consecutiveOverruns: 0,
  };
}
