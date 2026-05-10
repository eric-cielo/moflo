/**
 * #1053 S1: memory_retrieve and memory_search must surface RAG navigation
 * metadata so callers can traverse the chunk graph instead of blindly
 * retrieving every search hit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

const chunkMetadata = JSON.stringify({
  type: 'chunk',
  parentDoc: 'doc-guidance-foo',
  parentPath: '.claude/guidance/foo.md',
  chunkIndex: 2,
  totalChunks: 5,
  prevChunk: 'chunk-guidance-foo-1',
  nextChunk: 'chunk-guidance-foo-3',
  siblings: ['chunk-guidance-foo-0', 'chunk-guidance-foo-1', 'chunk-guidance-foo-2'],
  hierarchicalParent: 'chunk-guidance-foo-0',
  hierarchicalChildren: null,
  chunkTitle: 'Section Two',
  headerLevel: 2,
});

const docMetadata = JSON.stringify({
  type: 'document',
  parentPath: '.claude/guidance/foo.md',
});

const searchSpy = vi.fn(async () => ({
  success: true,
  results: [
    { id: 'r1', key: 'chunk-guidance-foo-2', content: 'snippet...', score: 0.85, namespace: 'guidance', metadata: chunkMetadata },
    { id: 'r2', key: 'doc-guidance-foo',     content: 'doc snip', score: 0.62, namespace: 'guidance', metadata: docMetadata },
    { id: 'r3', key: 'manual-note',          content: 'note',     score: 0.55, namespace: 'default',  metadata: undefined },
  ],
  searchTime: 1,
}));

const getEntrySpy = vi.fn(async (opts: { key: string }) => {
  if (opts.key === 'chunk-guidance-foo-2') {
    return {
      success: true,
      found: true,
      entry: {
        id: 'r1',
        key: 'chunk-guidance-foo-2',
        namespace: 'guidance',
        content: 'full chunk content',
        accessCount: 1,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        hasEmbedding: true,
        tags: [],
        metadata: chunkMetadata,
      },
    };
  }
  return {
    success: true,
    found: true,
    entry: {
      id: 'r9',
      key: opts.key,
      namespace: 'default',
      content: 'plain',
      accessCount: 1,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      hasEmbedding: false,
      tags: [],
      metadata: '{}',
    },
  };
});

vi.mock('../memory/memory-initializer.js', () => ({
  storeEntry: vi.fn(),
  searchEntries: searchSpy,
  listEntries: vi.fn(),
  getEntry: getEntrySpy,
  deleteEntry: vi.fn(),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true, dbPath: '' })),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true, dbPath: '', tableExists: true, version: '3.0.0' })),
}));

vi.mock('../services/spell-gate.js', () => ({
  GateService: class { recordMemorySearched(): void { /* no-op */ } notifyMemoryGate(): void { /* no-op */ } },
}));

beforeEach(() => {
  searchSpy.mockClear();
  getEntrySpy.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function getTool(name: string): Promise<MCPTool> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const tool = (mod.memoryTools as MCPTool[]).find(t => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool;
}

describe('memory_retrieve — RAG navigation surface (#1053 S1)', () => {
  it('returns full navigation object for chunk entries', async () => {
    const tool = await getTool('memory_retrieve');
    const result = await tool.handler({ key: 'chunk-guidance-foo-2', namespace: 'guidance' }) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.navigation).toEqual({
      parentDoc: 'doc-guidance-foo',
      parentPath: '.claude/guidance/foo.md',
      prevChunk: 'chunk-guidance-foo-1',
      nextChunk: 'chunk-guidance-foo-3',
      siblings: ['chunk-guidance-foo-0', 'chunk-guidance-foo-1', 'chunk-guidance-foo-2'],
      chunkIndex: 2,
      totalChunks: 5,
      hierarchicalParent: 'chunk-guidance-foo-0',
      hierarchicalChildren: null,
      chunkTitle: 'Section Two',
      headerLevel: 2,
    });
  });

  it('returns navigation: null for non-chunk entries', async () => {
    const tool = await getTool('memory_retrieve');
    const result = await tool.handler({ key: 'manual-note' }) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.navigation).toBeNull();
  });
});

describe('memory_search — RAG navigation crumb (#1053 S1)', () => {
  it('attaches compact navigation to chunk results, null otherwise', async () => {
    const tool = await getTool('memory_search');
    const result = await tool.handler({ query: 'something' }) as { results: Array<Record<string, unknown>> };

    expect(result.results).toHaveLength(3);

    expect(result.results[0].navigation).toEqual({
      parentDoc: 'doc-guidance-foo',
      prevChunk: 'chunk-guidance-foo-1',
      nextChunk: 'chunk-guidance-foo-3',
      chunkTitle: 'Section Two',
    });

    // doc-* entries have type='document' — not navigable as chunks.
    expect(result.results[1].navigation).toBeNull();

    // Manually-stored entries with no metadata column.
    expect(result.results[2].navigation).toBeNull();
  });
});

describe('memory_get_neighbors — chunk traversal (#1053 S2)', () => {
  it('returns prev + next by default', async () => {
    // Add neighbor responses to getEntrySpy.
    getEntrySpy.mockImplementation(async (opts: { key: string }) => {
      if (opts.key === 'chunk-guidance-foo-2') {
        return {
          success: true, found: true,
          entry: {
            id: 'r1', key: 'chunk-guidance-foo-2', namespace: 'guidance',
            content: 'mid', accessCount: 0, createdAt: 'x', updatedAt: 'x',
            hasEmbedding: true, tags: [], metadata: chunkMetadata,
          },
        };
      }
      if (opts.key === 'chunk-guidance-foo-1' || opts.key === 'chunk-guidance-foo-3') {
        return {
          success: true, found: true,
          entry: {
            id: opts.key, key: opts.key, namespace: 'guidance',
            content: `content for ${opts.key}`, accessCount: 0, createdAt: 'x', updatedAt: 'x',
            hasEmbedding: true, tags: [],
            metadata: JSON.stringify({ type: 'chunk', parentDoc: 'doc-guidance-foo', chunkTitle: opts.key }),
          },
        };
      }
      return { success: true, found: false };
    });

    const tool = await getTool('memory_get_neighbors');
    const result = await tool.handler({ key: 'chunk-guidance-foo-2', namespace: 'guidance' }) as {
      success: boolean; total: number; neighbors: Array<{ key: string; navigation: unknown }>;
    };

    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    const keys = result.neighbors.map(n => n.key).sort();
    expect(keys).toEqual(['chunk-guidance-foo-1', 'chunk-guidance-foo-3']);
    // Each neighbor carries its own navigation (full shape).
    expect(result.neighbors[0].navigation).toBeTruthy();
  });

  it('returns success:false when source is not a chunk', async () => {
    getEntrySpy.mockImplementation(async () => ({
      success: true, found: true,
      entry: {
        id: 'd1', key: 'doc-foo', namespace: 'guidance',
        content: 'doc body', accessCount: 0, createdAt: 'x', updatedAt: 'x',
        hasEmbedding: true, tags: [],
        metadata: JSON.stringify({ type: 'document' }),
      },
    }));

    const tool = await getTool('memory_get_neighbors');
    const result = await tool.handler({ key: 'doc-foo', namespace: 'guidance' }) as {
      success: boolean; error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no chunk metadata/);
  });

  it('returns success:false when source key not found', async () => {
    getEntrySpy.mockImplementation(async () => ({ success: true, found: false }));

    const tool = await getTool('memory_get_neighbors');
    const result = await tool.handler({ key: 'missing', namespace: 'guidance' }) as {
      success: boolean; error: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('handles include=siblings and skips the source key itself', async () => {
    getEntrySpy.mockImplementation(async (opts: { key: string }) => {
      if (opts.key === 'chunk-guidance-foo-2') {
        return {
          success: true, found: true,
          entry: {
            id: 'r1', key: 'chunk-guidance-foo-2', namespace: 'guidance',
            content: 'mid', accessCount: 0, createdAt: 'x', updatedAt: 'x',
            hasEmbedding: true, tags: [], metadata: chunkMetadata,
          },
        };
      }
      return {
        success: true, found: true,
        entry: {
          id: opts.key, key: opts.key, namespace: 'guidance',
          content: `c-${opts.key}`, accessCount: 0, createdAt: 'x', updatedAt: 'x',
          hasEmbedding: true, tags: [],
          metadata: JSON.stringify({ type: 'chunk', chunkTitle: opts.key }),
        },
      };
    });

    const tool = await getTool('memory_get_neighbors');
    const result = await tool.handler({
      key: 'chunk-guidance-foo-2',
      namespace: 'guidance',
      include: ['siblings'],
    }) as { neighbors: Array<{ key: string }> };

    const keys = result.neighbors.map(n => n.key);
    // siblings = [foo-0, foo-1, foo-2]; self (foo-2) excluded.
    expect(keys.sort()).toEqual(['chunk-guidance-foo-0', 'chunk-guidance-foo-1']);
  });
});
