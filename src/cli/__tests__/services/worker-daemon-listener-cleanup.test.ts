/**
 * Worker Daemon — Signal + Emitter Listener Cleanup (#667)
 *
 * Verifies that WorkerDaemon.stop() detaches the SIGTERM/SIGINT/SIGHUP
 * handlers it registered in the constructor and clears its own EventEmitter
 * subscribers, so repeated construction (in tests + smoke harnesses) does
 * not accumulate listeners and trip MaxListenersExceededWarning.
 *
 * Unlike the other worker-daemon test files, this one deliberately does NOT
 * mock process.on — the assertions are about real listener counts on the
 * process object.
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

import { WorkerDaemon, getDaemon, stopDaemon } from '../../services/worker-daemon.js';

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

function snapshotSignalCounts(): Record<typeof SIGNALS[number], number> {
  return {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGHUP: process.listenerCount('SIGHUP'),
  };
}

function buildDaemon(): WorkerDaemon {
  return new WorkerDaemon('/tmp/test-listener-cleanup', {
    autoStart: false,
    workers: [
      { type: 'map', intervalMs: 1000, priority: 'normal', description: 'test', enabled: true },
    ],
  });
}

describe('WorkerDaemon listener cleanup (#667)', () => {
  let baseline: Record<typeof SIGNALS[number], number>;

  beforeEach(() => {
    baseline = snapshotSignalCounts();
  });

  afterEach(() => {
    // Defensive: ensure no stray listeners survive a failing assertion.
    for (const sig of SIGNALS) {
      const current = process.listenerCount(sig);
      if (current > baseline[sig]) {
        process.removeAllListeners(sig);
      }
    }
  });

  it('constructor adds one handler to each of SIGTERM, SIGINT, SIGHUP', () => {
    const daemon = buildDaemon();
    const after = snapshotSignalCounts();
    for (const sig of SIGNALS) {
      expect(after[sig]).toBe(baseline[sig] + 1);
    }
    return daemon.stop();
  });

  it('stop() removes the signal handlers it registered (without start)', async () => {
    const daemon = buildDaemon();
    await daemon.stop();
    const after = snapshotSignalCounts();
    for (const sig of SIGNALS) {
      expect(after[sig]).toBe(baseline[sig]);
    }
  });

  it('stop() removes the signal handlers after start()', async () => {
    const daemon = buildDaemon();
    await daemon.start();
    await daemon.stop();
    const after = snapshotSignalCounts();
    for (const sig of SIGNALS) {
      expect(after[sig]).toBe(baseline[sig]);
    }
  });

  it('stop() clears the daemon EventEmitter listeners', async () => {
    const daemon = buildDaemon();
    daemon.on('worker:complete', () => {});
    daemon.on('worker:start', () => {});
    daemon.on('worker:deferred', () => {});
    daemon.on('worker:disabled-overrun', () => {});

    expect(daemon.listenerCount('worker:complete')).toBe(1);
    expect(daemon.listenerCount('worker:start')).toBe(1);
    expect(daemon.listenerCount('worker:deferred')).toBe(1);
    expect(daemon.listenerCount('worker:disabled-overrun')).toBe(1);

    await daemon.stop();

    expect(daemon.listenerCount('worker:complete')).toBe(0);
    expect(daemon.listenerCount('worker:start')).toBe(0);
    expect(daemon.listenerCount('worker:deferred')).toBe(0);
    expect(daemon.listenerCount('worker:disabled-overrun')).toBe(0);
  });

  it('stop() is idempotent: second call does not throw or double-remove', async () => {
    const daemon = buildDaemon();
    await daemon.stop();
    const afterFirst = snapshotSignalCounts();

    await expect(daemon.stop()).resolves.not.toThrow();

    const afterSecond = snapshotSignalCounts();
    for (const sig of SIGNALS) {
      expect(afterSecond[sig]).toBe(afterFirst[sig]);
      expect(afterSecond[sig]).toBe(baseline[sig]);
    }
  });

  it('terminal events still fire to subscribers before the emitter is cleared', async () => {
    const daemon = buildDaemon();
    await daemon.start();

    const stoppedSpy = vi.fn();
    daemon.on('stopped', stoppedSpy);

    await daemon.stop();
    expect(stoppedSpy).toHaveBeenCalledTimes(1);
  });

  it('stopDaemon() releases the singleton so the next getDaemon() returns a fresh instance', async () => {
    const first = getDaemon('/tmp/test-singleton', { autoStart: false });
    await stopDaemon();
    const second = getDaemon('/tmp/test-singleton', { autoStart: false });
    expect(second).not.toBe(first);
    await stopDaemon();
  });

  it('many constructions + stops do not leak listeners (the regression scenario)', async () => {
    // The original bug fired MaxListenersExceededWarning at 11 listeners.
    // Construct 20 daemons in sequence — each pair (new + stop) must net to
    // zero listener delta.
    for (let i = 0; i < 20; i++) {
      const daemon = buildDaemon();
      await daemon.stop();
    }
    const after = snapshotSignalCounts();
    for (const sig of SIGNALS) {
      expect(after[sig]).toBe(baseline[sig]);
    }
  });
});
