import { describe, it, expect, beforeEach } from 'vitest';
import { ToolAccessorImpl } from '../src/core/tool-accessor.js';
import { WorkflowToolRegistry } from '../src/registry/tool-registry.js';
import type { WorkflowTool } from '../src/types/workflow-tool.types.js';

function makeTool(name: string): WorkflowTool {
  return {
    name,
    description: `${name} tool`,
    version: '1.0.0',
    capabilities: ['read', 'write'],
    initialize: async () => {},
    dispose: async () => {},
    execute: async (action, params) => ({
      success: true,
      data: { action, params },
    }),
    listActions: () => [{
      name: 'get',
      description: 'Get something',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }],
  };
}

describe('ToolAccessorImpl', () => {
  let registry: WorkflowToolRegistry;
  let accessor: ToolAccessorImpl;

  beforeEach(() => {
    registry = new WorkflowToolRegistry();
    registry.register(makeTool('http'), 'shipped');
    registry.register(makeTool('slack'), 'user');
    accessor = new ToolAccessorImpl(registry);
  });

  it('has returns true for registered tool', () => {
    expect(accessor.has('http')).toBe(true);
    expect(accessor.has('slack')).toBe(true);
  });

  it('has returns false for unregistered tool', () => {
    expect(accessor.has('nonexistent')).toBe(false);
  });

  it('get returns tool by name', () => {
    const tool = accessor.get('http');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('http');
  });

  it('get returns undefined for unknown tool', () => {
    expect(accessor.get('nonexistent')).toBeUndefined();
  });

  it('list returns all tools with metadata', () => {
    const tools = accessor.list();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('http');
    expect(tools[0].capabilities).toEqual(['read', 'write']);
  });

  it('execute delegates to tool', async () => {
    const result = await accessor.execute('http', 'get', { url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      action: 'get',
      params: { url: 'https://example.com' },
    });
  });

  it('execute returns error for unknown tool', async () => {
    const result = await accessor.execute('nonexistent', 'get', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('WorkflowRunner tool integration', () => {
  it('runner works without tool registry (backward compat)', async () => {
    // Import dynamically to avoid circular issues
    const { createRunner } = await import('../src/factory/runner-factory.js');
    const runner = createRunner();

    // A simple workflow with a wait step
    const result = await runner.run(
      {
        name: 'test-no-tools',
        version: '1.0.0',
        steps: [{
          id: 'step1',
          type: 'wait',
          config: { duration: 0 },
        }],
      },
      {},
    );
    expect(result.success).toBe(true);
  });

  it('runner with tool registry populates context.tools', async () => {
    const { WorkflowRunner } = await import('../src/core/runner.js');
    const { StepCommandRegistry } = await import('../src/core/step-command-registry.js');

    const toolRegistry = new WorkflowToolRegistry();
    toolRegistry.register(makeTool('http'), 'shipped');

    const stepRegistry = new StepCommandRegistry();
    // Register a custom step that checks for tools in context
    let contextTools: unknown = undefined;
    stepRegistry.register({
      type: 'check-tools',
      description: 'Check if tools are in context',
      configSchema: { type: 'object' },
      validate: () => ({ valid: true, errors: [] }),
      execute: async (_config, context) => {
        contextTools = context.tools;
        return {
          success: true,
          data: { hasTools: !!context.tools, hasHttp: context.tools?.has('http') ?? false },
        };
      },
      describeOutputs: () => [],
    });

    const runner = new WorkflowRunner(
      stepRegistry,
      { async get() { return undefined; }, async has() { return false; } },
      { async read() { return null; }, async write() {}, async search() { return []; } },
      toolRegistry,
    );

    const result = await runner.run(
      {
        name: 'test-with-tools',
        version: '1.0.0',
        steps: [{
          id: 'step1',
          type: 'check-tools',
          config: {},
        }],
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(contextTools).toBeDefined();
    expect(result.outputs.step1).toEqual({ hasTools: true, hasHttp: true });
  });
});
