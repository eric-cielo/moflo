/**
 * #1149 — memory_stats MCP handler must never silently report 0 entries on
 * populated DBs.
 *
 * Pre-#1149 the handler iterated /api/memory/list with `limit: 100000`, the
 * daemon capped that at 10 000 → 400 → tryDaemonList defaulted `total: 0`,
 * and the handler returned `totalEntries: 0` on every DB with > 10 000 rows
 * or any daemon-side validation slip. These tests pin the post-#1149 contract:
 *
 *   - happy path goes through tryDaemonStats() (dedicated stats endpoint)
 *   - daemon unreachable → fall back to a direct getNamespaceCounts() query
 *   - daemon explicitly errored → surface the error (no `totalEntries: 0`)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../mcp-tools/types.js';

const getNamespaceCountsSpy = vi.fn();
const listEntriesSpy = vi.fn();
const checkInitSpy = vi.fn(async () => ({
  initialized: true,
  version: '3.0.0',
  features: { vectorEmbeddings: true, hnswIndex: true, semanticSearch: true },
}));
const tryDaemonStatsSpy = vi.fn();

vi.mock('../memory/memory-initializer.js', () => ({
  storeEntry: vi.fn(),
  searchEntries: vi.fn(),
  listEntries: listEntriesSpy,
  getEntry: vi.fn(),
  deleteEntry: vi.fn(),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true, dbPath: '' })),
  checkMemoryInitialization: checkInitSpy,
  getNamespaceCounts: getNamespaceCountsSpy,
}));

vi.mock('../memory/daemon-write-client.js', () => ({
  tryDaemonStats: tryDaemonStatsSpy,
}));

vi.mock('../services/spell-gate.js', () => ({
  GateService: class { recordMemorySearched(): void { /* no-op */ } },
}));

beforeEach(() => {
  getNamespaceCountsSpy.mockReset();
  listEntriesSpy.mockReset();
  tryDaemonStatsSpy.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

async function getStatsTool(): Promise<MCPTool> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const t = (mod.memoryTools as MCPTool[]).find(x => x.name === 'memory_stats');
  if (!t) throw new Error('memory_stats not registered');
  return t;
}

interface StatsResult {
  initialized?: boolean;
  totalEntries?: number;
  entriesWithEmbeddings?: number;
  embeddingCoverage?: string;
  namespaces?: Record<string, number>;
  error?: string;
  backend?: string;
}

describe('memory_stats — #1149 dedicated stats endpoint', () => {
  it('uses tryDaemonStats() result on success (no listEntries iteration)', async () => {
    tryDaemonStatsSpy.mockResolvedValue({
      routed: true,
      data: {
        namespaces: { guidance: 2620, 'code-map': 1414, patterns: 1297 },
        totalEntries: 5331,
        withEmbeddings: 5300,
      },
    });

    const tool = await getStatsTool();
    const result = await tool.handler({}) as StatsResult;

    expect(result.totalEntries).toBe(5331);
    expect(result.entriesWithEmbeddings).toBe(5300);
    expect(result.namespaces?.guidance).toBe(2620);
    expect(result.namespaces?.['code-map']).toBe(1414);
    // The 100k-row iteration MUST NOT fire on the happy path — that's the
    // foot-gun this issue fixes.
    expect(listEntriesSpy).not.toHaveBeenCalled();
  });

  it('falls back to direct getNamespaceCounts when daemon unreachable (routed:false)', async () => {
    tryDaemonStatsSpy.mockResolvedValue({ routed: false });
    getNamespaceCountsSpy.mockResolvedValue({
      namespaces: { learnings: 42, guidance: 9 },
      total: 51,
      withEmbeddings: 50,
    });

    const tool = await getStatsTool();
    const result = await tool.handler({}) as StatsResult;

    expect(getNamespaceCountsSpy).toHaveBeenCalledTimes(1);
    expect(result.totalEntries).toBe(51);
    expect(result.entriesWithEmbeddings).toBe(50);
    expect(result.namespaces?.learnings).toBe(42);
    expect(listEntriesSpy).not.toHaveBeenCalled();
  });

  it('surfaces the daemon error on routed:true with error (no fake 0)', async () => {
    tryDaemonStatsSpy.mockResolvedValue({
      routed: true,
      error: 'limit must be a positive integer ≤10000',
    });

    const tool = await getStatsTool();
    const result = await tool.handler({}) as StatsResult;

    expect(result.error).toContain('limit must be a positive integer');
    // Critical: must NOT report totalEntries:0 — that's the exact silent
    // wrong-answer the issue catches.
    expect(result.totalEntries).toBeUndefined();
    expect(getNamespaceCountsSpy).not.toHaveBeenCalled();
  });

  it('computes embeddingCoverage from server-side counts', async () => {
    tryDaemonStatsSpy.mockResolvedValue({
      routed: true,
      data: { namespaces: { x: 10 }, totalEntries: 10, withEmbeddings: 7 },
    });

    const tool = await getStatsTool();
    const result = await tool.handler({}) as StatsResult;

    expect(result.embeddingCoverage).toBe('70.0%');
  });

  it('reports 0% embedding coverage when DB is empty (clean signal, not a lie)', async () => {
    tryDaemonStatsSpy.mockResolvedValue({
      routed: true,
      data: { namespaces: {}, totalEntries: 0, withEmbeddings: 0 },
    });

    const tool = await getStatsTool();
    const result = await tool.handler({}) as StatsResult;

    expect(result.totalEntries).toBe(0);
    expect(result.embeddingCoverage).toBe('0%');
  });

  it('reports real N from direct fallback even when N is large (≥10 000)', async () => {
    // The exact reproducer in the issue body: post-#1145, N>10000 caused
    // the old iterate-namespaces path to 400 on the limit cap and silently
    // default to totalEntries:0. With the new path the daemon may be
    // unreachable mid-call; the direct fallback must still report N.
    tryDaemonStatsSpy.mockResolvedValue({ routed: false });
    getNamespaceCountsSpy.mockResolvedValue({
      namespaces: { bulk: 12_345 },
      total: 12_345,
      withEmbeddings: 12_000,
    });

    const tool = await getStatsTool();
    const result = await tool.handler({}) as StatsResult;

    expect(result.totalEntries).toBe(12_345);
    expect(result.entriesWithEmbeddings).toBe(12_000);
  });
});
