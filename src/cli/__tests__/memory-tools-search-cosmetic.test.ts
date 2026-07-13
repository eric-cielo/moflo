/**
 * #1053 S6: cosmetic trims to memory_search response.
 *  - default limit: 10 → 8 → 5 (#1262 lever #1)
 *  - default threshold: 0.3 → 0.5  (#837 explicit-zero passthrough still respected)
 *  - similarity rounded to 2dp
 *  - searchTime dropped from MCP envelope (CLI keeps it)
 *  - backend retained — doctor depends on it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

const searchSpy = vi.fn(async () => ({
  success: true,
  results: [
    { id: '1', key: 'k1', namespace: 'g', content: 'c', score: 0.87654321, metadata: undefined },
  ],
  searchTime: 5,
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
  GateService: class { recordMemorySearched(): void { /* no-op */ } },
}));

beforeEach(() => { searchSpy.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

async function getSearchTool(): Promise<MCPTool> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const t = (mod.memoryTools as MCPTool[]).find(x => x.name === 'memory_search');
  if (!t) throw new Error('memory_search not registered');
  return t;
}

describe('memory_search — cosmetic trims (#1053 S6)', () => {
  it('default limit is 5 (#1262 lever #1)', async () => {
    const tool = await getSearchTool();
    await tool.handler({ query: 'q' });
    expect(searchSpy.mock.calls[0]?.[0]?.limit).toBe(5);
  });

  it('rounds similarity to 2 decimal places', async () => {
    const tool = await getSearchTool();
    const result = await tool.handler({ query: 'q' }) as { results: Array<{ similarity: number }> };
    expect(result.results[0].similarity).toBe(0.88);
  });

  it('omits searchTime from MCP envelope', async () => {
    const tool = await getSearchTool();
    const result = await tool.handler({ query: 'q' }) as Record<string, unknown>;
    expect(result).not.toHaveProperty('searchTime');
  });

  it('retains backend field (doctor dependency)', async () => {
    const tool = await getSearchTool();
    const result = await tool.handler({ query: 'q' }) as { backend: string };
    expect(result.backend).toBe('node:sqlite + HNSW');
  });
});
