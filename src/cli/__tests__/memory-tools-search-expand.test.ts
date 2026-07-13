/**
 * #1262 lever #3: single-call neighbor expansion + steer-away-from-Read hint.
 *
 * - expand:'neighbors' inlines each chunk hit's prev/next chunk content in ONE
 *   call, so the model doesn't fall back to a full-doc Read for context.
 * - a `nextStep` steer appears ONLY when chunk hits are present and the caller
 *   did NOT expand — so the hint costs no tokens on the common case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

// A chunk hit whose compact navigation points at prev/next chunk keys.
const chunkMeta = JSON.stringify({
  type: 'chunk',
  parentDoc: 'doc-1',
  parentPath: '.claude/guidance/x.md',
  prevChunk: 'chunk-0',
  nextChunk: 'chunk-2',
  chunkTitle: 'Middle',
});

const searchSpy = vi.fn(async () => ({
  success: true,
  results: [{ id: '1', key: 'chunk-1', namespace: 'guidance', content: 'middle body', score: 0.9, metadata: chunkMeta }],
  searchTime: 1,
}));

// getEntry resolves the neighbor keys the expansion asks for.
const getEntrySpy = vi.fn(async ({ key }: { key: string }) => ({
  found: true,
  entry: { id: key, key, namespace: 'guidance', content: `${key} body`, accessCount: 0, createdAt: '', updatedAt: '', hasEmbedding: true, tags: [], metadata: undefined },
}));

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
  GateService: class { recordMemorySearched(): void { /* no-op */ } },
}));

beforeEach(() => { searchSpy.mockClear(); getEntrySpy.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

async function getSearchTool(): Promise<MCPTool> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const t = (mod.memoryTools as MCPTool[]).find(x => x.name === 'memory_search');
  if (!t) throw new Error('memory_search not registered');
  return t;
}

type Hit = { key: string; expanded?: Array<{ position: string; key: string; value: unknown }> };
type Envelope = { results: Hit[]; nextStep?: string };

describe('memory_search — expand + steer (#1262 lever #3)', () => {
  it('does NOT expand by default and surfaces the steer on chunk hits', async () => {
    const tool = await getSearchTool();
    const res = await tool.handler({ query: 'q' }) as Envelope;
    expect(getEntrySpy).not.toHaveBeenCalled();
    expect(res.results[0].expanded).toBeUndefined();
    expect(res.nextStep).toMatch(/expand:'neighbors'/);
  });

  it("expand:'neighbors' inlines prev/next chunk content in one call", async () => {
    const tool = await getSearchTool();
    const res = await tool.handler({ query: 'q', expand: 'neighbors' }) as Envelope;
    const expanded = res.results[0].expanded ?? [];
    expect(expanded.map(e => e.key).sort()).toEqual(['chunk-0', 'chunk-2']);
    expect(expanded.find(e => e.position === 'prev')?.value).toBe('chunk-0 body');
    expect(expanded.find(e => e.position === 'next')?.value).toBe('chunk-2 body');
    // When the caller already expanded, the steer must not also fire.
    expect(res.nextStep).toBeUndefined();
  });

  it('omits the steer entirely when there are no chunk hits', async () => {
    searchSpy.mockResolvedValueOnce({
      success: true,
      results: [{ id: '1', key: 'plain', namespace: 'learnings', content: 'x', score: 0.9, metadata: undefined }],
      searchTime: 1,
    });
    const tool = await getSearchTool();
    const res = await tool.handler({ query: 'q' }) as Envelope;
    expect(res.nextStep).toBeUndefined();
  });
});
