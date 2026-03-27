/**
 * V3 MCP Worker Tools Tests
 *
 * Tests for background worker MCP tools:
 * - worker/dispatch
 * - worker/status
 * - worker/cancel
 * - worker/triggers
 * - worker/detect
 * - worker/results
 * - worker/stats
 * - worker/context
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the worker-dispatch module before importing worker-tools
const mockDispatcher = {
  dispatch: vi.fn().mockResolvedValue('worker-123'),
  getWorker: vi.fn().mockReturnValue(null),
  cancel: vi.fn().mockResolvedValue(true),
  getTriggers: vi.fn().mockReturnValue({
    ultralearn: { description: 'Deep learning', priority: 'normal', estimatedDuration: 30000, capabilities: ['learn'] },
    optimize: { description: 'Optimization', priority: 'high', estimatedDuration: 20000, capabilities: ['optimize'] },
    consolidate: { description: 'Consolidation', priority: 'low', estimatedDuration: 15000, capabilities: ['consolidate'] },
    predict: { description: 'Prediction', priority: 'normal', estimatedDuration: 10000, capabilities: ['predict'] },
    audit: { description: 'Security audit', priority: 'critical', estimatedDuration: 25000, capabilities: ['audit'] },
    map: { description: 'Mapping', priority: 'normal', estimatedDuration: 20000, capabilities: ['map'] },
    preload: { description: 'Preloading', priority: 'low', estimatedDuration: 5000, capabilities: ['preload'] },
    deepdive: { description: 'Deep analysis', priority: 'normal', estimatedDuration: 40000, capabilities: ['analyze'] },
    document: { description: 'Documentation', priority: 'normal', estimatedDuration: 15000, capabilities: ['document'] },
    refactor: { description: 'Refactoring', priority: 'normal', estimatedDuration: 30000, capabilities: ['refactor'] },
    benchmark: { description: 'Benchmarking', priority: 'normal', estimatedDuration: 20000, capabilities: ['benchmark'] },
    testgaps: { description: 'Test gaps', priority: 'normal', estimatedDuration: 25000, capabilities: ['test'] },
  }),
  detectTriggers: vi.fn().mockReturnValue({ triggers: [], confidence: 0 }),
  getSessionWorkers: vi.fn().mockReturnValue([]),
  getStats: vi.fn().mockReturnValue({
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }),
  getContextForInjection: vi.fn().mockReturnValue(''),
};

vi.mock('../../packages/swarm/src/workers/worker-dispatch.js', () => ({
  WorkerDispatchService: vi.fn(() => mockDispatcher),
  getWorkerDispatchService: vi.fn(() => mockDispatcher),
}));

import {
  dispatchWorkerTool,
  workerStatusTool,
  cancelWorkerTool,
  triggersTool,
  detectTriggersTool,
  workerResultsTool,
  workerStatsTool,
  workerContextTool,
  workerTools,
} from '../tools/worker-tools.js';
import { ToolContext } from '../types.js';

describe('Worker Tools', () => {
  let mockContext: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      sessionId: 'test-session',
    };
  });

  describe('worker/dispatch', () => {
    it('should have correct tool definition', () => {
      expect(dispatchWorkerTool.name).toBe('worker/dispatch');
      expect(dispatchWorkerTool.category).toBe('worker');
      expect(dispatchWorkerTool.inputSchema.required).toContain('trigger');
      expect(dispatchWorkerTool.inputSchema.required).toContain('context');
    });

    it('should dispatch a worker', async () => {
      const result = await dispatchWorkerTool.handler({
        trigger: 'audit',
        context: 'src/auth/',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.workerId).toBe('worker-123');
      expect(result.trigger).toBe('audit');
      expect(result.status).toBe('pending');
      expect(result.startedAt).toBeDefined();
    });
  });

  describe('worker/status', () => {
    it('should have correct tool definition', () => {
      expect(workerStatusTool.name).toBe('worker/status');
      expect(workerStatusTool.category).toBe('worker');
      expect(workerStatusTool.inputSchema.required).toContain('workerId');
    });

    it('should return not-found for unknown worker', async () => {
      const result = await workerStatusTool.handler({
        workerId: 'unknown-worker',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.found).toBe(false);
      expect(result.workerId).toBe('unknown-worker');
    });
  });

  describe('worker/cancel', () => {
    it('should have correct tool definition', () => {
      expect(cancelWorkerTool.name).toBe('worker/cancel');
      expect(cancelWorkerTool.category).toBe('worker');
      expect(cancelWorkerTool.inputSchema.required).toContain('workerId');
    });

    it('should cancel a worker', async () => {
      const result = await cancelWorkerTool.handler({
        workerId: 'worker-123',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.cancelled).toBe(true);
      expect(result.workerId).toBe('worker-123');
    });
  });

  describe('worker/triggers', () => {
    it('should have correct tool definition', () => {
      expect(triggersTool.name).toBe('worker/triggers');
      expect(triggersTool.category).toBe('worker');
      expect(triggersTool.cacheable).toBe(true);
    });

    it('should list available triggers', async () => {
      const result = await triggersTool.handler({}, mockContext);

      expect(result).toBeDefined();
      expect(Array.isArray(result.triggers)).toBe(true);
      expect(result.triggers.length).toBeGreaterThan(0);
    });
  });

  describe('worker/detect', () => {
    it('should have correct tool definition', () => {
      expect(detectTriggersTool.name).toBe('worker/detect');
      expect(detectTriggersTool.category).toBe('worker');
      expect(detectTriggersTool.inputSchema.required).toContain('text');
    });

    it('should detect triggers in text', async () => {
      const result = await detectTriggersTool.handler({
        text: 'Please run a security audit on the auth module',
      }, mockContext);

      expect(result).toBeDefined();
      expect(mockDispatcher.detectTriggers).toHaveBeenCalledWith(
        'Please run a security audit on the auth module'
      );
    });
  });

  describe('worker/results', () => {
    it('should have correct tool definition', () => {
      expect(workerResultsTool.name).toBe('worker/results');
      expect(workerResultsTool.category).toBe('worker');
    });

    it('should return worker results', async () => {
      const result = await workerResultsTool.handler({
        sessionId: 'test-session',
      }, mockContext);

      expect(result).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.total).toBeDefined();
    });
  });

  describe('worker/stats', () => {
    it('should have correct tool definition', () => {
      expect(workerStatsTool.name).toBe('worker/stats');
      expect(workerStatsTool.category).toBe('worker');
      expect(workerStatsTool.cacheable).toBe(true);
    });

    it('should return worker statistics', async () => {
      const result = await workerStatsTool.handler({}, mockContext);

      expect(result).toBeDefined();
      expect(typeof result.total).toBe('number');
      expect(result.byTrigger).toBeDefined();
    });
  });

  describe('worker/context', () => {
    it('should have correct tool definition', () => {
      expect(workerContextTool.name).toBe('worker/context');
      expect(workerContextTool.category).toBe('worker');
      expect(workerContextTool.inputSchema.required).toContain('sessionId');
    });

    it('should return context for session', async () => {
      const result = await workerContextTool.handler({
        sessionId: 'test-session',
      }, mockContext);

      expect(result).toBeDefined();
      expect(typeof result.context).toBe('string');
      expect(typeof result.workerCount).toBe('number');
      expect(typeof result.hasResults).toBe('boolean');
    });
  });

  describe('Tool Collection', () => {
    it('should export all 8 worker tools', () => {
      expect(workerTools).toHaveLength(8);
    });

    it('should have unique tool names', () => {
      const names = workerTools.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should all have handlers', () => {
      workerTools.forEach(tool => {
        expect(typeof tool.handler).toBe('function');
      });
    });

    it('should all be in worker category', () => {
      workerTools.forEach(tool => {
        expect(tool.category).toBe('worker');
      });
    });
  });
});
