import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

const searchSpy = vi.fn(async () => ({
  success: true,
  results: [{ id: 'r1', key: 'k', content: 'c', score: 0.05, namespace: 'ns' }],
  searchTime: 1,
}));

vi.mock('../memory/memory-initializer.js', () => ({
  storeEntry: vi.fn(),
  searchEntries: searchSpy,
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true, dbPath: '' })),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true, dbPath: '', tableExists: true, version: '3.0.0' })),
}));

vi.mock('../services/spell-gate.js', () => ({
  GateService: { notifyMemoryGate: vi.fn() },
}));

beforeEach(() => {
  searchSpy.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function getMemorySearchTool(): Promise<MCPTool> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const tool = (mod.memoryTools as MCPTool[]).find(t => t.name === 'memory_search');
  if (!tool) throw new Error('memory_search not registered');
  return tool;
}

describe('memory_search MCP handler — threshold passthrough (#837)', () => {
  it('passes a caller-supplied threshold of 0 through to searchEntries', async () => {
    const tool = await getMemorySearchTool();
    await tool.handler({ query: 'q', threshold: 0 });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]?.threshold).toBe(0);
  });

  it('uses 0.3 when threshold is omitted (backwards compatible default)', async () => {
    const tool = await getMemorySearchTool();
    await tool.handler({ query: 'q' });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]?.threshold).toBe(0.3);
  });

  it('passes other explicit thresholds through unchanged', async () => {
    const tool = await getMemorySearchTool();
    await tool.handler({ query: 'q', threshold: 0.05 });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]?.threshold).toBe(0.05);
  });
});
