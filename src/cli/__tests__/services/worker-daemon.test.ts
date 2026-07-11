/**
 * Worker Daemon Tests
 *
 * Happy-path smoke tests for WorkerDaemon: construction,
 * start/stop lifecycle, worker registration, status.
 *
 * All filesystem and child_process calls are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs so the constructor doesn't touch real filesystem
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation((filePath: string) => {
      // Return empty JSON for state/config files
      if (filePath.includes('daemon-state.json') || filePath.includes('config.json')) {
        return '{}';
      }
      throw new Error('ENOENT');
    }),
    appendFileSync: vi.fn(),
  };
});

// Mock the headless executor so constructor doesn't spawn processes
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

// Suppress process signal handlers in tests
const originalOn = process.on.bind(process);
vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
  if (['SIGTERM', 'SIGINT', 'SIGHUP'].includes(event)) return process;
  return originalOn(event, handler);
});

import { WorkerDaemon } from '../../services/worker-daemon.js';

describe('WorkerDaemon', () => {
  let daemon: WorkerDaemon;
  const projectRoot = '/tmp/test-project';

  beforeEach(() => {
    daemon = new WorkerDaemon(projectRoot, {
      autoStart: false,
      workers: [
        { type: 'map', intervalMs: 60000, priority: 'normal', description: 'Codebase mapping', enabled: true },
        { type: 'refactor', intervalMs: 120000, priority: 'normal', description: 'Refactoring suggestions', enabled: false },
      ],
    });
  });

  afterEach(async () => {
    await daemon.stop();
  });

  // ===========================================================================
  // Construction
  // ===========================================================================
  describe('construction', () => {
    it('should create a daemon instance', () => {
      expect(daemon).toBeInstanceOf(WorkerDaemon);
    });

    it('should be an EventEmitter', () => {
      expect(typeof daemon.on).toBe('function');
      expect(typeof daemon.emit).toBe('function');
    });

    it('default registry no longer ships audit/predict/document (#970)', () => {
      // No explicit workers config — falls through to DEFAULT_WORKERS
      const defaultDaemon = new WorkerDaemon('/tmp/test-default', { autoStart: false });
      const workers = defaultDaemon.getStatus().config.workers;
      // audit/predict/document removed in #970; optimize/testgaps in #1258.
      for (const removed of ['audit', 'predict', 'document', 'optimize', 'testgaps'] as const) {
        expect(workers.find(w => w.type === removed as never)).toBeUndefined();
      }
    });

    it('default registry keeps only the local (free) scheduled workers enabled', () => {
      // After #1258 the sole default-scheduled workers are map + consolidate,
      // both pure local computation with no model calls. The billed
      // optimize/testgaps workers were removed (moved to /quicken + /ward).
      const defaultDaemon = new WorkerDaemon('/tmp/test-default-others', { autoStart: false });
      const workers = defaultDaemon.getStatus().config.workers;
      const map = workers.find(w => w.type === 'map');
      const consolidate = workers.find(w => w.type === 'consolidate');
      expect(map?.enabled).toBe(true);
      expect(consolidate?.enabled).toBe(true);
      // No billed worker ships enabled-by-default.
      expect(workers.find(w => w.type === 'optimize' as never)).toBeUndefined();
      expect(workers.find(w => w.type === 'testgaps' as never)).toBeUndefined();
    });
  });

  // ===========================================================================
  // Start / Stop Lifecycle
  // ===========================================================================
  describe('start', () => {
    it('should emit started event with pid', async () => {
      const handler = vi.fn();
      daemon.on('started', handler);

      await daemon.start();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: process.pid })
      );
    });

    it('should set running status to true', async () => {
      await daemon.start();
      const status = daemon.getStatus();
      expect(status.running).toBe(true);
    });

    it('should be idempotent — second start emits warning', async () => {
      const warned = vi.fn();
      daemon.on('warning', warned);

      await daemon.start();
      await daemon.start();

      expect(warned).toHaveBeenCalledWith('Daemon already running');
    });
  });

  describe('stop', () => {
    it('should emit stopped event', async () => {
      const handler = vi.fn();
      daemon.on('stopped', handler);

      await daemon.start();
      await daemon.stop();

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should set running status to false', async () => {
      await daemon.start();
      await daemon.stop();
      const status = daemon.getStatus();
      expect(status.running).toBe(false);
    });

    it('should be idempotent — stop when not running emits warning', async () => {
      const warned = vi.fn();
      daemon.on('warning', warned);
      await daemon.stop();
      expect(warned).toHaveBeenCalledWith('Daemon not running');
    });
  });

  // ===========================================================================
  // Status
  // ===========================================================================
  describe('getStatus', () => {
    it('should return status with workers map', () => {
      const status = daemon.getStatus();
      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('pid');
      expect(status).toHaveProperty('workers');
      expect(status).toHaveProperty('config');
      expect(status.workers).toBeInstanceOf(Map);
    });

    it('should include all configured worker types', () => {
      const status = daemon.getStatus();
      expect(status.workers.has('map')).toBe(true);
      expect(status.workers.has('refactor')).toBe(true);
    });

    it('should initialize worker states with zero counts', () => {
      const status = daemon.getStatus();
      const mapState = status.workers.get('map')!;
      expect(mapState.runCount).toBe(0);
      expect(mapState.successCount).toBe(0);
      expect(mapState.failureCount).toBe(0);
      expect(mapState.isRunning).toBe(false);
    });
  });

  // ===========================================================================
  // Headless Executor
  // ===========================================================================
  describe('headless', () => {
    it('should report headless as unavailable when Claude Code is not present', () => {
      expect(daemon.isHeadlessAvailable()).toBe(false);
    });
  });

  // ===========================================================================
  // State migration on upgrade (#970)
  // ===========================================================================
  describe('initializeWorkerStates — unknown-type drop (#970)', () => {
    it('silently drops daemon-state entries for worker types no longer in the union', async () => {
      const fs = await import('fs');
      const stateFile = '/tmp/test-stale-workers/daemon-state.json';
      const staleState = {
        running: false,
        workers: {
          // Pre-#970 workers no longer in the WorkerType union
          audit:    { runCount: 7, successCount: 7, failureCount: 0, averageDurationMs: 1000, consecutiveOverruns: 0 },
          predict:  { runCount: 3, successCount: 0, failureCount: 3, averageDurationMs: 500,  consecutiveOverruns: 2 },
          document: { runCount: 1, successCount: 1, failureCount: 0, averageDurationMs: 200,  consecutiveOverruns: 0 },
          // Survivor — should be restored
          map:      { runCount: 5, successCount: 5, failureCount: 0, averageDurationMs: 800,  consecutiveOverruns: 0 },
        },
        config: { workers: [{ type: 'map', enabled: true }] },
        savedAt: '2026-04-01T00:00:00.000Z',
      };
      // Path-aware override: the constructor reads config.json BEFORE
      // daemon-state.json, so a one-shot mock would intercept the wrong file.
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('daemon-state.json')) return JSON.stringify(staleState);
        if (p.includes('config.json')) return '{}';
        throw new Error('ENOENT');
      });

      const upgraded = new WorkerDaemon('/tmp/test-stale-workers', { autoStart: false, stateFile });
      const workers = upgraded.getStatus().workers;

      // Stale entries are dropped — no orphan keys, no crash
      expect(workers.has('audit' as never)).toBe(false);
      expect(workers.has('predict' as never)).toBe(false);
      expect(workers.has('document' as never)).toBe(false);
      // Survivor's runtime stats are restored
      expect(workers.get('map')?.runCount).toBe(5);
      expect(workers.get('map')?.successCount).toBe(5);
    });
  });
});
