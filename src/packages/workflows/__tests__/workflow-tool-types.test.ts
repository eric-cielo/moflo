import { describe, it, expect } from 'vitest';
import type {
  WorkflowTool,
  ToolOutput,
  ToolAction,
  ToolCapability,
  ToolAccessor,
  ToolRegistryEntry,
  ToolSource,
} from '../src/types/workflow-tool.types.js';

describe('WorkflowTool types', () => {
  it('ToolOutput has required shape', () => {
    const output: ToolOutput = { success: true, data: { body: 'hello' } };
    expect(output.success).toBe(true);
    expect(output.data).toEqual({ body: 'hello' });
    expect(output.error).toBeUndefined();
    expect(output.duration).toBeUndefined();
  });

  it('ToolOutput with error fields', () => {
    const output: ToolOutput = {
      success: false,
      data: {},
      error: 'connection refused',
      duration: 150,
    };
    expect(output.success).toBe(false);
    expect(output.error).toBe('connection refused');
    expect(output.duration).toBe(150);
  });

  it('ToolAction has input/output schemas', () => {
    const action: ToolAction = {
      name: 'get',
      description: 'HTTP GET request',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'number' },
          body: { type: 'string' },
        },
      },
    };
    expect(action.name).toBe('get');
    expect(action.inputSchema.required).toContain('url');
  });

  it('ToolCapability covers expected values', () => {
    const caps: ToolCapability[] = ['read', 'write', 'search', 'subscribe', 'authenticate'];
    expect(caps).toHaveLength(5);
  });

  it('ToolSource covers expected values', () => {
    const sources: ToolSource[] = ['shipped', 'user', 'npm'];
    expect(sources).toHaveLength(3);
  });

  it('WorkflowTool can be structurally implemented', () => {
    const tool: WorkflowTool = {
      name: 'test-tool',
      description: 'A test tool',
      version: '1.0.0',
      capabilities: ['read'] as const,
      initialize: async () => {},
      dispose: async () => {},
      execute: async (_action, _params) => ({ success: true, data: {} }),
      listActions: () => [],
    };
    expect(tool.name).toBe('test-tool');
    expect(tool.capabilities).toContain('read');
  });

  it('ToolRegistryEntry has expected structure', () => {
    const mockTool: WorkflowTool = {
      name: 'mock',
      description: 'mock',
      version: '0.0.1',
      capabilities: [],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: {} }),
      listActions: () => [],
    };
    const entry: ToolRegistryEntry = {
      tool: mockTool,
      source: 'shipped',
      registeredAt: new Date(),
    };
    expect(entry.source).toBe('shipped');
    expect(entry.tool.name).toBe('mock');
  });

  it('ToolAccessor interface is structurally valid', () => {
    const mockTool: WorkflowTool = {
      name: 'http',
      description: 'HTTP tool',
      version: '1.0.0',
      capabilities: ['read', 'write'],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: {} }),
      listActions: () => [],
    };
    const accessor: ToolAccessor = {
      get: (name: string) => name === 'http' ? mockTool : undefined,
      has: (name: string) => name === 'http',
      list: () => [{ name: 'http', description: 'HTTP tool', capabilities: ['read', 'write'] }],
      execute: async (_toolName, _action, _params) => ({ success: true, data: {} }),
    };
    expect(accessor.has('http')).toBe(true);
    expect(accessor.get('http')?.name).toBe('http');
  });
});
