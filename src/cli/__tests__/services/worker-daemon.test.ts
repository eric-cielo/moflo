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
  HeadlessWorkerExecutor: vi.fn().mockImplementation(() => ({
    isAvailable: vi.fn().mockResolvedValue(false),
    on: vi.fn(),
  })),
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
        { type: 'audit', intervalMs: 120000, priority: 'critical', description: 'Security analysis', enabled: false },
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
      expect(status.workers.has('audit')).toBe(true);
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
});
