/**
 * Worker Queue Tests
 *
 * Happy-path smoke tests for WorkerQueue: enqueue, dequeue,
 * priority ordering, basic retry logic.
 *
 * Note: We avoid calling shutdown() in afterEach because it has a 30s
 * wait loop for processing tasks. Instead each test manages its own cleanup.
 */

import { describe, it, expect, vi } from 'vitest';

import { WorkerQueue } from '../../services/worker-queue.js';

describe('WorkerQueue', () => {
  // ===========================================================================
  // Construction
  // ===========================================================================
  describe('construction', () => {
    it('should create a queue instance', () => {
      const queue = new WorkerQueue();
      expect(queue).toBeInstanceOf(WorkerQueue);
    });

    it('should accept partial config overrides', () => {
      const queue = new WorkerQueue({ maxRetries: 5, defaultTimeoutMs: 60000 });
      expect(queue).toBeInstanceOf(WorkerQueue);
    });
  });

  // ===========================================================================
  // Enqueue
  // ===========================================================================
  describe('enqueue', () => {
    it('should enqueue a task and return a task ID', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('ultralearn', { prompt: 'hello' });
      expect(taskId).toMatch(/^task-/);
    });

    it('should store the task with pending status', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('audit');
      const task = await queue.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task!.status).toBe('pending');
      expect(task!.workerType).toBe('audit');
    });

    it('should use provided priority', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('optimize', {}, { priority: 'critical' });
      const task = await queue.getTask(taskId);
      expect(task!.priority).toBe('critical');
    });

    it('should default priority to normal', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('map');
      const task = await queue.getTask(taskId);
      expect(task!.priority).toBe('normal');
    });

    it('should reject invalid worker type', async () => {
      const queue = new WorkerQueue();
      await expect(queue.enqueue('' as any)).rejects.toThrow('Invalid worker type');
    });

    it('should emit taskEnqueued event', async () => {
      const queue = new WorkerQueue();
      const handler = vi.fn();
      queue.on('taskEnqueued', handler);
      await queue.enqueue('consolidate');
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ===========================================================================
  // Dequeue
  // ===========================================================================
  describe('dequeue', () => {
    it('should dequeue a pending task and mark it as processing', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('ultralearn', { prompt: 'test' });
      const task = await queue.dequeue(['ultralearn']);
      expect(task).not.toBeNull();
      expect(task!.status).toBe('processing');
      expect(task!.workerType).toBe('ultralearn');
      expect(task!.startedAt).toBeInstanceOf(Date);

      // Complete the task so it doesn't stay in processing state
      await queue.complete(taskId, { success: true, output: '', duration: 0, workerType: 'ultralearn' });
    });

    it('should return null when queue is empty', async () => {
      const queue = new WorkerQueue();
      const task = await queue.dequeue(['ultralearn']);
      expect(task).toBeNull();
    });

    it('should return null for non-matching worker types', async () => {
      const queue = new WorkerQueue();
      await queue.enqueue('audit');
      const task = await queue.dequeue(['optimize']);
      expect(task).toBeNull();
    });
  });

  // ===========================================================================
  // Priority Ordering
  // ===========================================================================
  describe('priority ordering', () => {
    it('should dequeue higher-priority tasks first', async () => {
      const queue = new WorkerQueue();

      // Enqueue in ascending priority order — queue should reorder
      await queue.enqueue('audit', { prompt: 'low' }, { priority: 'low' });
      await queue.enqueue('audit', { prompt: 'normal' }, { priority: 'normal' });
      await queue.enqueue('audit', { prompt: 'critical' }, { priority: 'critical' });

      const first = await queue.dequeue(['audit']);
      await queue.complete(first!.id, { success: true, output: '', duration: 0, workerType: 'audit' });
      expect(first!.priority).toBe('critical');

      const second = await queue.dequeue(['audit']);
      await queue.complete(second!.id, { success: true, output: '', duration: 0, workerType: 'audit' });
      expect(second!.priority).toBe('normal');

      const third = await queue.dequeue(['audit']);
      await queue.complete(third!.id, { success: true, output: '', duration: 0, workerType: 'audit' });
      expect(third!.priority).toBe('low');
    });
  });

  // ===========================================================================
  // Complete / Fail
  // ===========================================================================
  describe('complete', () => {
    it('should mark a task as completed with result', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('optimize');
      await queue.dequeue(['optimize']);

      const result = { success: true, output: 'done', duration: 100, workerType: 'optimize' as const };
      await queue.complete(taskId, result);

      const task = await queue.getTask(taskId);
      expect(task!.status).toBe('completed');
      expect(task!.completedAt).toBeInstanceOf(Date);

      const stored = await queue.getResult(taskId);
      expect(stored).toEqual(result);
    });
  });

  describe('fail', () => {
    it('should retry a failed task when retries remain', async () => {
      vi.useFakeTimers();
      try {
        const queue = new WorkerQueue();
        const taskId = await queue.enqueue('map', {}, { maxRetries: 2 });
        await queue.dequeue(['map']);

        await queue.fail(taskId, 'oops');

        const task = await queue.getTask(taskId);
        expect(task!.status).toBe('pending');
        expect(task!.retryCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should move task to failed status when retries exhausted', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('map', {}, { maxRetries: 0 });
      await queue.dequeue(['map']);

      await queue.fail(taskId, 'permanent failure');

      const task = await queue.getTask(taskId);
      expect(task!.status).toBe('failed');
      expect(task!.error).toBe('permanent failure');
    });

    it('should move to failed when retryable is false', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('map', {}, { maxRetries: 3 });
      await queue.dequeue(['map']);

      await queue.fail(taskId, 'shutdown', false);

      const task = await queue.getTask(taskId);
      expect(task!.status).toBe('failed');
    });
  });

  // ===========================================================================
  // Cancel
  // ===========================================================================
  describe('cancel', () => {
    it('should cancel a pending task', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('audit');
      const cancelled = await queue.cancel(taskId);
      expect(cancelled).toBe(true);

      const task = await queue.getTask(taskId);
      expect(task!.status).toBe('cancelled');
    });

    it('should return false when cancelling a processing task', async () => {
      const queue = new WorkerQueue();
      const taskId = await queue.enqueue('audit');
      await queue.dequeue(['audit']); // now processing
      const cancelled = await queue.cancel(taskId);
      expect(cancelled).toBe(false);

      // Clean up — complete the task
      await queue.complete(taskId, { success: true, output: '', duration: 0, workerType: 'audit' });
    });
  });

  // ===========================================================================
  // Worker Registration
  // ===========================================================================
  describe('worker registration', () => {
    it('should register and list workers', async () => {
      const queue = new WorkerQueue();
      const workerId = await queue.registerWorker(['audit', 'optimize']);
      expect(workerId).toMatch(/^worker-/);

      const workers = await queue.getWorkers();
      expect(workers.length).toBe(1);
      expect(workers[0].workerTypes).toContain('audit');
    });

    it('should unregister a worker', async () => {
      const queue = new WorkerQueue();
      await queue.registerWorker(['map']);
      await queue.unregisterWorker();
      const workers = await queue.getWorkers();
      expect(workers.length).toBe(0);
    });
  });

  // ===========================================================================
  // Stats
  // ===========================================================================
  describe('getStats', () => {
    it('should return queue statistics', async () => {
      const queue = new WorkerQueue();
      const stats = await queue.getStats();
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('processing');
      expect(stats).toHaveProperty('byPriority');
    });
  });
});
