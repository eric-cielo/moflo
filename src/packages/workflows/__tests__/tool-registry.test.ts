import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowToolRegistry } from '../src/registry/tool-registry.js';
import type { WorkflowTool } from '../src/types/workflow-tool.types.js';

function makeTool(name: string, overrides?: Partial<WorkflowTool>): WorkflowTool {
  return {
    name,
    description: `${name} tool`,
    version: '1.0.0',
    capabilities: ['read'],
    initialize: async () => {},
    dispose: async () => {},
    execute: async () => ({ success: true, data: {} }),
    listActions: () => [],
    ...overrides,
  };
}

describe('WorkflowToolRegistry', () => {
  let registry: WorkflowToolRegistry;

  beforeEach(() => {
    registry = new WorkflowToolRegistry();
  });

  it('registers and retrieves a tool by name', () => {
    const tool = makeTool('http');
    registry.register(tool);

    expect(registry.has('http')).toBe(true);
    expect(registry.get('http')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeTool('http'));
    expect(() => registry.register(makeTool('http'))).toThrow(
      'Workflow tool "http" is already registered'
    );
  });

  it('throws on invalid tool (missing required methods)', () => {
    const invalid = { name: 'bad', description: 'x' } as unknown as WorkflowTool;
    expect(() => registry.register(invalid)).toThrow(
      'does not implement WorkflowTool interface'
    );
  });

  it('throws on tool with empty name', () => {
    const tool = makeTool('');
    expect(() => registry.register(tool)).toThrow(
      'does not implement WorkflowTool interface'
    );
  });

  it('unregisters a tool', () => {
    registry.register(makeTool('http'));
    expect(registry.unregister('http')).toBe(true);
    expect(registry.has('http')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('unregister returns false for unknown tool', () => {
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('get returns undefined for unknown tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered tools', () => {
    registry.register(makeTool('http'), 'shipped');
    registry.register(makeTool('slack'), 'user');

    const entries = registry.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool.name).toBe('http');
    expect(entries[0].source).toBe('shipped');
    expect(entries[1].tool.name).toBe('slack');
    expect(entries[1].source).toBe('user');
  });

  it('names returns all registered tool names', () => {
    registry.register(makeTool('http'));
    registry.register(makeTool('slack'));
    expect(registry.names()).toEqual(['http', 'slack']);
  });

  it('clear removes all tools', () => {
    registry.register(makeTool('http'));
    registry.register(makeTool('slack'));
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.names()).toEqual([]);
  });

  it('scan with no directories returns zero registered', async () => {
    const result = await registry.scan();
    expect(result.registered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('scan with nonexistent directory returns zero registered', async () => {
    const reg = new WorkflowToolRegistry({
      shippedDir: '/nonexistent/path/tools',
    });
    const result = await reg.scan();
    expect(result.registered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('tracks source correctly', () => {
    registry.register(makeTool('http'), 'shipped');
    registry.register(makeTool('slack'), 'user');
    registry.register(makeTool('db'), 'npm');

    const entries = registry.list();
    const byName = Object.fromEntries(entries.map(e => [e.tool.name, e.source]));
    expect(byName.http).toBe('shipped');
    expect(byName.slack).toBe('user');
    expect(byName.db).toBe('npm');
  });

  it('registeredAt is set on registration', () => {
    const before = new Date();
    registry.register(makeTool('http'));
    const after = new Date();

    const entry = registry.list()[0];
    expect(entry.registeredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(entry.registeredAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
