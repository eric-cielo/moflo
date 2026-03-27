/**
 * V3 MCP Hooks Tools Tests
 *
 * Tests for hooks system MCP tools:
 * - hooks/pre-edit
 * - hooks/post-edit
 * - hooks/pre-command
 * - hooks/post-command
 * - hooks/route
 * - hooks/explain
 * - hooks/pretrain
 * - hooks/metrics
 * - hooks/list
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the neural module before importing hooks-tools
vi.mock('../../packages/neural/src/index.js', () => {
  const mockReasoningBank = {
    initialize: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    store: vi.fn().mockResolvedValue(undefined),
    storeTrajectory: vi.fn(),
    judge: vi.fn().mockResolvedValue({ verdict: 'success', score: 0.8 }),
    distill: vi.fn().mockResolvedValue({ patterns: [] }),
    distillBatch: vi.fn().mockResolvedValue([]),
    consolidate: vi.fn().mockResolvedValue(undefined),
    getMetrics: vi.fn().mockReturnValue({
      totalTrajectories: 0,
      totalMemories: 0,
      avgQualityScore: 0,
      retrievalLatencyMs: 0,
    }),
    getStats: vi.fn().mockReturnValue({
      trajectoryCount: 10,
      successfulTrajectories: 8,
      memoryCount: 5,
      patternCount: 3,
      retrievalCount: 20,
      distillationCount: 15,
      agentdbEnabled: 1,
      avgRetrievalTimeMs: 1.5,
      avgDistillationTimeMs: 2.0,
      avgJudgeTimeMs: 0.5,
      avgConsolidationTimeMs: 3.0,
    }),
    getDetailedMetrics: vi.fn().mockReturnValue({
      routing: { totalRoutes: 5, avgConfidence: 0.85, topAgents: [] },
      edits: { totalEdits: 10, successRate: 0.9, commonPatterns: [] },
      commands: { totalCommands: 8, successRate: 0.95, avgExecutionTime: 150, commonCommands: [] },
    }),
  };
  return {
    ReasoningBank: vi.fn(() => mockReasoningBank),
    createReasoningBank: vi.fn(() => mockReasoningBank),
  };
});

import {
  preEditTool,
  postEditTool,
  preCommandTool,
  postCommandTool,
  routeTool,
  explainTool,
  pretrainTool,
  metricsTool,
  listHooksTool,
  hooksTools,
} from '../tools/hooks-tools.js';
import { ToolContext } from '../types.js';

describe('Hooks Tools', () => {
  let mockContext: ToolContext;

  beforeEach(() => {
    mockContext = {
      sessionId: 'test-session',
    };
  });

  describe('hooks/pre-edit', () => {
    it('should have correct tool definition', () => {
      expect(preEditTool.name).toBe('hooks/pre-edit');
      expect(preEditTool.category).toBe('hooks');
      expect(preEditTool.inputSchema.required).toContain('filePath');
    });

    it('should return pre-edit result', async () => {
      const result = await preEditTool.handler({
        filePath: '/src/example.ts',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.filePath).toBe('/src/example.ts');
      expect(result.operation).toBeDefined();
    });
  });

  describe('hooks/post-edit', () => {
    it('should have correct tool definition', () => {
      expect(postEditTool.name).toBe('hooks/post-edit');
      expect(postEditTool.category).toBe('hooks');
      expect(postEditTool.inputSchema.required).toContain('filePath');
      expect(postEditTool.inputSchema.required).toContain('success');
    });

    it('should record a successful edit', async () => {
      const result = await postEditTool.handler({
        filePath: '/src/example.ts',
        success: true,
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.filePath).toBe('/src/example.ts');
      expect(result.success).toBe(true);
      expect(result.recorded).toBe(true);
      expect(result.recordedAt).toBeDefined();
    });
  });

  describe('hooks/pre-command', () => {
    it('should have correct tool definition', () => {
      expect(preCommandTool.name).toBe('hooks/pre-command');
      expect(preCommandTool.category).toBe('hooks');
      expect(preCommandTool.inputSchema.required).toContain('command');
    });

    it('should assess command risk', async () => {
      const result = await preCommandTool.handler({
        command: 'npm test',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.command).toBe('npm test');
      expect(typeof result.shouldProceed).toBe('boolean');
    });
  });

  describe('hooks/post-command', () => {
    it('should have correct tool definition', () => {
      expect(postCommandTool.name).toBe('hooks/post-command');
      expect(postCommandTool.category).toBe('hooks');
      expect(postCommandTool.inputSchema.required).toContain('command');
      expect(postCommandTool.inputSchema.required).toContain('success');
    });

    it('should record a command execution', async () => {
      const result = await postCommandTool.handler({
        command: 'npm test',
        success: true,
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.command).toBe('npm test');
      expect(result.recorded).toBe(true);
      expect(result.recordedAt).toBeDefined();
    });
  });

  describe('hooks/route', () => {
    it('should have correct tool definition', () => {
      expect(routeTool.name).toBe('hooks/route');
      expect(routeTool.category).toBe('hooks');
      expect(routeTool.inputSchema.required).toContain('task');
    });

    it('should route a task to an agent', async () => {
      const result = await routeTool.handler({
        task: 'Write unit tests for the auth module',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.task).toBe('Write unit tests for the auth module');
      expect(result.recommendedAgent).toBeDefined();
      expect(typeof result.confidence).toBe('number');
    });
  });

  describe('hooks/explain', () => {
    it('should have correct tool definition', () => {
      expect(explainTool.name).toBe('hooks/explain');
      expect(explainTool.category).toBe('hooks');
      expect(explainTool.inputSchema.required).toContain('task');
    });

    it('should explain routing decision', async () => {
      const result = await explainTool.handler({
        task: 'Review code quality',
      }, mockContext);

      expect(result).toBeDefined();
      expect(result.task).toBe('Review code quality');
      expect(result.recommendedAgent).toBeDefined();
      expect(result.explanation).toBeDefined();
    });
  });

  describe('hooks/pretrain', () => {
    it('should have correct tool definition', () => {
      expect(pretrainTool.name).toBe('hooks/pretrain');
      expect(pretrainTool.category).toBe('hooks');
    });

    it('should return pretrain result', async () => {
      const result = await pretrainTool.handler({}, mockContext);

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(result.statistics).toBeDefined();
    });
  });

  describe('hooks/metrics', () => {
    it('should have correct tool definition', () => {
      expect(metricsTool.name).toBe('hooks/metrics');
      expect(metricsTool.category).toBe('hooks');
    });

    it('should return metrics', async () => {
      const result = await metricsTool.handler({}, mockContext);

      expect(result).toBeDefined();
      expect(result.category).toBeDefined();
      expect(result.summary).toBeDefined();
    });
  });

  describe('hooks/list', () => {
    it('should have correct tool definition', () => {
      expect(listHooksTool.name).toBe('hooks/list');
      expect(listHooksTool.category).toBe('hooks');
      expect(listHooksTool.cacheable).toBe(true);
    });

    it('should list hooks', async () => {
      const result = await listHooksTool.handler({}, mockContext);

      expect(result).toBeDefined();
      expect(Array.isArray(result.hooks)).toBe(true);
      expect(result.total).toBeDefined();
      expect(result.byCategory).toBeDefined();
    });
  });

  describe('Tool Collection', () => {
    it('should export all 9 hooks tools', () => {
      expect(hooksTools).toHaveLength(9);
    });

    it('should have unique tool names', () => {
      const names = hooksTools.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should all have handlers', () => {
      hooksTools.forEach(tool => {
        expect(typeof tool.handler).toBe('function');
      });
    });

    it('should all be in hooks category', () => {
      hooksTools.forEach(tool => {
        expect(tool.category).toBe('hooks');
      });
    });
  });
});
