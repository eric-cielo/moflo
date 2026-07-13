/**
 * #1262 lever #1: dedup-by-source. The same underlying source is often indexed
 * under multiple keys — a file as `file:<path>` (code-map) AND `pattern:file:<path>`
 * (patterns), a test as `file:<path>` AND `test-file:<path>`. Those collapse to a
 * single result slot (highest score kept), so every returned slot is a DISTINCT
 * source. The handler over-fetches (limit*3) so a full `limit` of uniques survives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

// Score-desc set with deliberate cross-namespace duplication:
//   src/a.ts   -> file: (0.95), pattern:file: (0.93), test-file: (0.70)  = 1 source
//   Foo symbol -> pattern:class:Foo (0.92)                                = distinct
//   src/b.ts   -> file: (0.90)                                            = distinct
const dupResults = [
  { id: '1', key: 'file:src/a.ts', namespace: 'code-map', content: 'a', score: 0.95, metadata: undefined },
  { id: '2', key: 'pattern:class:Foo', namespace: 'patterns', content: 'Foo', score: 0.92, metadata: undefined },
  { id: '3', key: 'pattern:file:src/a.ts', namespace: 'patterns', content: 'a-pat', score: 0.93, metadata: undefined },
  { id: '4', key: 'file:src/b.ts', namespace: 'code-map', content: 'b', score: 0.90, metadata: undefined },
  { id: '5', key: 'test-file:src/a.ts', namespace: 'tests', content: 'a-test', score: 0.70, metadata: undefined },
];

const searchSpy = vi.fn(async () => ({ success: true, results: dupResults, searchTime: 1 }));

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

type Envelope = { results: Array<{ key: string; similarity: number }>; total: number };

describe('memory_search — dedup-by-source (#1262 lever #1)', () => {
  it('collapses same-source representations, keeping the highest-scoring one', async () => {
    const tool = await getSearchTool();
    const res = await tool.handler({ query: 'q' }) as Envelope;
    // src/a.ts appeared 3x (file/pattern:file/test-file) -> one slot, the 0.95 one.
    const keys = res.results.map(r => r.key);
    expect(keys).toEqual(['file:src/a.ts', 'pattern:class:Foo', 'file:src/b.ts']);
    expect(res.total).toBe(3);
    // The kept src/a.ts slot is the highest-scoring representation.
    expect(res.results.find(r => r.key === 'file:src/a.ts')?.similarity).toBe(0.95);
  });

  it('keeps a symbol view (pattern:class) distinct from the file source', async () => {
    const tool = await getSearchTool();
    const res = await tool.handler({ query: 'q' }) as Envelope;
    // pattern:class:Foo is a symbol view, NOT collapsed into any file source.
    expect(res.results.some(r => r.key === 'pattern:class:Foo')).toBe(true);
  });

  it('trims to the user-facing limit AFTER dedup', async () => {
    const tool = await getSearchTool();
    const res = await tool.handler({ query: 'q', limit: 2 }) as Envelope;
    expect(res.results.map(r => r.key)).toEqual(['file:src/a.ts', 'pattern:class:Foo']);
    expect(res.total).toBe(2);
  });
});
