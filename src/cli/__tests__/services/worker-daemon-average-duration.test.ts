/**
 * Worker Daemon — averageDurationMs across mixed success/failure runs (#666)
 *
 * Pre-fix: the success branch updated averageDurationMs but the failure
 * branch did not, while both branches incremented runCount, so the displayed
 * average drifted low whenever a worker had any failures. Both branches now
 * funnel through finalizeRun(), so the average stays correct regardless of
 * outcome mix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  HeadlessWorkerExecutor: vi.fn().mockImplementation(function () {
    return {
      isAvailable: vi.fn().mockResolvedValue(false),
      on: vi.fn(),
    };
  }),
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

describe('WorkerDaemon averageDurationMs (#666)', () => {
  let daemon: WorkerDaemon;
  let synthNow: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    synthNow = 1_700_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => synthNow);

    daemon = new WorkerDaemon('/tmp/test-avg-duration', {
      autoStart: false,
      workers: [
        { type: 'map', intervalMs: 60_000, priority: 'normal', description: 'test', enabled: true },
      ],
    });
  });

  afterEach(async () => {
    nowSpy.mockRestore();
    vi.restoreAllMocks();
    await daemon.stop();
  });

  /**
   * Drive a single triggerWorker run with a precise observed duration.
   *
   * executeWorker reads `startTime = Date.now()` before awaiting
   * runWorkerLogic, then `durationMs = Date.now() - startTime` after. We
   * advance the synth clock from inside the runWorkerLogic stub so the
   * observed duration is exactly `durationMs`, regardless of any other
   * Date.now() calls in the path (workerId, circuit breaker, lastRun).
   */
  async function runOnce(durationMs: number, outcome: 'ok' | 'fail'): Promise<void> {
    vi.spyOn(
      daemon as unknown as { runWorkerLogic: () => Promise<unknown> },
      'runWorkerLogic',
    ).mockImplementationOnce(async () => {
      synthNow += durationMs;
      if (outcome === 'fail') throw new Error('synthetic failure');
      return { ok: true };
    });
    await daemon.triggerWorker('map');
  }

  it('averageDurationMs equals arithmetic mean across mixed success and failure runs', async () => {
    for (let i = 0; i < 90; i++) await runOnce(1000, 'ok');
    for (let i = 0; i < 10; i++) await runOnce(5000, 'fail');

    const state = daemon.getStatus().workers.get('map')!;
    expect(state.runCount).toBe(100);
    expect(state.successCount).toBe(90);
    expect(state.failureCount).toBe(10);
    const expectedMean = (90 * 1000 + 10 * 5000) / 100;
    expect(state.averageDurationMs).toBeCloseTo(expectedMean, 5);
  });

  it('averageDurationMs updates on a failure-only sequence (no success ever runs)', async () => {
    for (const d of [200, 400, 600]) await runOnce(d, 'fail');

    const state = daemon.getStatus().workers.get('map')!;
    expect(state.runCount).toBe(3);
    expect(state.failureCount).toBe(3);
    expect(state.successCount).toBe(0);
    expect(state.averageDurationMs).toBeCloseTo((200 + 400 + 600) / 3, 5);
  });
});
