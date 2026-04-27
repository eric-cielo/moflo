/**
 * Worker Daemon — Mid-Flight Cancellation (#669)
 *
 * Verifies that an in-flight worker run can be interrupted both by the
 * runWithTimeout timer firing AND by setWorkerEnabled(type, false), instead
 * of running to natural completion (the pre-#669 behaviour, which kept a
 * timed-out headless child consuming CPU + tokens for up to its own
 * internal timeout).
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

function buildDaemon(extra: Partial<DaemonConfig> = {}): WorkerDaemon {
  return new WorkerDaemon('/tmp/test-cancel', {
    autoStart: false,
    workers: [
      { type: 'map', intervalMs: 1000, priority: 'normal', description: 'test', enabled: true },
    ],
    ...extra,
  });
}

/**
 * Spy on `runWorkerLogic` and capture the AbortSignal it was called with,
 * holding the run open until the test resolves it. This is the seam #669's
 * acceptance criteria call out: a stub that observes the signal asserts it
 * fires on timeout and on disable.
 */
function captureSignalAndHang(daemon: WorkerDaemon): {
  signalReady: Promise<AbortSignal>;
  finishRun: () => void;
} {
  let resolveSignal!: (s: AbortSignal) => void;
  const signalReady = new Promise<AbortSignal>((r) => { resolveSignal = r; });
  let finishRun!: () => void;
  const runDone = new Promise<void>((r) => { finishRun = r; });

  vi.spyOn(
    daemon as unknown as { runWorkerLogic: (cfg: unknown, signal?: AbortSignal) => Promise<unknown> },
    'runWorkerLogic',
  ).mockImplementation(async (_cfg, signal) => {
    if (signal) resolveSignal(signal);
    await runDone;
    return { ok: true };
  });

  return { signalReady, finishRun };
}

describe('WorkerDaemon mid-flight cancellation (#669)', () => {
  let daemon: WorkerDaemon;

  afterEach(async () => {
    if (daemon) await daemon.stop();
    vi.restoreAllMocks();
  });

  describe('runWithTimeout aborts the signal on timeout', () => {
    beforeEach(() => {
      daemon = buildDaemon({ workerTimeoutMs: 50 });
    });

    it('signal becomes aborted when the run exceeds workerTimeoutMs', async () => {
      const { signalReady, finishRun } = captureSignalAndHang(daemon);

      const triggerPromise = daemon.triggerWorker('map');

      const signal = await signalReady;
      expect(signal.aborted).toBe(false);

      const result = await triggerPromise;
      expect(signal.aborted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/i);

      finishRun();
    });
  });

  describe('setWorkerEnabled(type, false) aborts the signal mid-flight', () => {
    beforeEach(() => {
      // Generous timeout so disable wins the race, not the timer.
      daemon = buildDaemon({ workerTimeoutMs: 10_000 });
    });

    it('signal becomes aborted when the worker is disabled while running', async () => {
      const { signalReady, finishRun } = captureSignalAndHang(daemon);

      const triggerPromise = daemon.triggerWorker('map');

      const signal = await signalReady;
      expect(signal.aborted).toBe(false);

      daemon.setWorkerEnabled('map', false);
      expect(signal.aborted).toBe(true);

      finishRun();
      const result = await triggerPromise;
      // The local-mode mock resolves cleanly; the meaningful assertion is
      // that the signal already fired (above), which is what callers like
      // HeadlessWorkerExecutor observe to kill their child process.
      expect(result.success).toBe(true);
    });
  });
});
