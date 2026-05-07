/**
 * Tests for bridge-entries `bridgeStoreEntry` — covers the #649 fix:
 *  - reads the actual model name from the bridge embedder (no hardcoded
 *    'Xenova/all-MiniLM-L6-v2')
 *  - returns success: false on embed failure (no silent null insertion)
 *  - intentional opt-out (generateEmbeddingFlag=false) tags the row 'none',
 *    not the schema default 'local', so the audit trail distinguishes
 *    intentional skips from failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  setBridgeEmbedderForTest,
  _resetBridgeEmbedderCacheForTest,
  type BridgeEmbedder,
} from '../memory/bridge-embedder.js';
import { bridgeSearchEntries, bridgeStoreEntry } from '../memory/bridge-entries.js';
import { _resetProjectRootForTest, execRows, getDb } from '../memory/bridge-core.js';
import { shutdownBridge, getControllerRegistry } from '../memory/memory-bridge.js';

let tmpDir: string;
let dbPath: string;
let originalCwd: string;

// Local stub instead of MockEmbeddingService (src/cli/embeddings/__tests__/mocks/)
// because we exercise the BridgeEmbedder contract — narrower than IEmbeddingService
// and supports failure injection directly.
class StubEmbedder implements BridgeEmbedder {
  readonly model: string;
  readonly dimensions: number;
  private vector: Float32Array | null;
  private failure: Error | null;

  constructor(opts: {
    model?: string;
    dimensions?: number;
    vector?: Float32Array | null;
    failure?: Error | null;
  } = {}) {
    this.model = opts.model ?? 'stub-embedder-v1';
    this.dimensions = opts.dimensions ?? 384;
    this.vector = opts.vector ?? new Float32Array(this.dimensions).fill(0.1);
    this.failure = opts.failure ?? null;
  }

  async embed(_text: string): Promise<Float32Array> {
    if (this.failure) throw this.failure;
    if (!this.vector) throw new Error('stub: no vector and no failure configured');
    return this.vector;
  }
}

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-bridge-entries-'));
  fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
  // Bridge resolves project root from cwd for ancillary paths
  // (.moflo/vector-stats.json). Isolate so tests don't clobber the
  // host project's stats cache.
  process.chdir(tmpDir);
  // Bridge caches project root at module level — reset so it picks up tmpDir.
  _resetProjectRootForTest();
  dbPath = path.join(tmpDir, '.swarm', 'memory.db');
  // Make sure no leftover bridge singleton points at a stale dbPath
  await shutdownBridge();
});

afterEach(async () => {
  setBridgeEmbedderForTest(null);
  _resetBridgeEmbedderCacheForTest();
  await shutdownBridge();
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  _resetProjectRootForTest();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function readRows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const reg = await getControllerRegistry(dbPath);
  if (!reg) throw new Error('test bridge registry unavailable');
  const ctx = getDb(reg);
  if (!ctx) throw new Error('test bridge db ctx unavailable');
  return execRows(ctx.db, sql, params);
}

describe('bridgeStoreEntry — embed failure surfacing (#649)', () => {
  it('returns success:false with error message when the embedder throws', async () => {
    setBridgeEmbedderForTest(
      new StubEmbedder({ failure: new Error('synthetic embed failure') }),
    );

    const result = await bridgeStoreEntry({
      key: 'k1',
      value: 'some content',
      namespace: 'test',
      dbPath,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('embedding generation failed');
    expect(result?.error).toContain('synthetic embed failure');
    const rows = await readRows('SELECT id FROM memory_entries WHERE key = ?', ['k1']);
    expect(rows).toHaveLength(0);
  });

});

describe('bridgeStoreEntry — model name passthrough (#649)', () => {
  it("tags inserted rows with the embedder's reported model, not 'Xenova/all-MiniLM-L6-v2'", async () => {
    setBridgeEmbedderForTest(
      new StubEmbedder({ model: 'custom-test-model-v2', dimensions: 384 }),
    );

    const result = await bridgeStoreEntry({
      key: 'k-model',
      value: 'content',
      namespace: 'test',
      dbPath,
    });

    expect(result?.success).toBe(true);
    expect(result?.embedding?.model).toBe('custom-test-model-v2');

    const rows = await readRows(
      'SELECT embedding_model FROM memory_entries WHERE key = ?',
      ['k-model'],
    );
    expect(rows[0]?.embedding_model).toBe('custom-test-model-v2');
    expect(rows[0]?.embedding_model).not.toBe('Xenova/all-MiniLM-L6-v2');
  });
});

describe('bridgeStoreEntry — UPSERT contract (#962)', () => {
  it('overwrites the existing row when upsert=true is passed for an existing (namespace,key)', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const first = await bridgeStoreEntry({
      key: 'k-upsert',
      value: 'first',
      namespace: 'test',
      upsert: true,
      dbPath,
    });
    expect(first?.success).toBe(true);

    const second = await bridgeStoreEntry({
      key: 'k-upsert',
      value: 'second',
      namespace: 'test',
      upsert: true,
      dbPath,
    });
    expect(second?.success).toBe(true);

    const rows = await readRows('SELECT content FROM memory_entries WHERE key = ?', ['k-upsert']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('second');
  });

  it('does NOT overwrite the existing row when upsert=false collides with an existing key', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const first = await bridgeStoreEntry({
      key: 'k-collide',
      value: 'first',
      namespace: 'test',
      upsert: false,
      dbPath,
    });
    expect(first?.success).toBe(true);

    // The default-INSERT path on a duplicate key trips a UNIQUE constraint
    // in sql.js. The bridge surfaces this via withDb (returns null + stderr
    // log) rather than throwing — what matters is the existing row stays
    // intact. Silent overwrite would mask the schedule-cancel bug pattern
    // even with upsert=false explicitly set.
    await bridgeStoreEntry({
      key: 'k-collide',
      value: 'second',
      namespace: 'test',
      upsert: false,
      dbPath,
    });

    const rows = await readRows('SELECT content FROM memory_entries WHERE key = ?', ['k-collide']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('first');
  });
});

describe('bridgeStoreEntry — opt-out path (#649)', () => {
  it("tags rows with 'none' when caller passes generateEmbeddingFlag=false", async () => {
    setBridgeEmbedderForTest(new StubEmbedder()); // present but won't be called

    const result = await bridgeStoreEntry({
      key: 'k-opt-out',
      value: 'content',
      namespace: 'test',
      generateEmbeddingFlag: false,
      dbPath,
    });

    expect(result?.success).toBe(true);
    expect(result?.embedding).toBeUndefined();

    const rows = await readRows(
      'SELECT embedding, embedding_model FROM memory_entries WHERE key = ?',
      ['k-opt-out'],
    );
    expect(rows[0]?.embedding).toBeNull();
    expect(rows[0]?.embedding_model).toBe('none');
    expect(rows[0]?.embedding_model).not.toBe('local');
  });
});

describe('bridgeStoreEntry — ephemeral namespace skip (#729)', () => {
  it.each([
    ['hive-mind'],
    ['tasklist'],
    ['epic-state'],
    ['test-bridge-fix'],
  ])("namespace=%s — writes embedding=NULL and embedding_model=NULL even when generateEmbeddingFlag is true", async (namespace) => {
    // Stub embedder is installed but must NOT be called for ephemeral writes.
    const embedSpy = vi.fn(async () => new Float32Array(384).fill(0.1));
    setBridgeEmbedderForTest({
      model: 'should-not-be-used',
      dimensions: 384,
      embed: embedSpy,
    });

    const result = await bridgeStoreEntry({
      key: 'k-ephemeral',
      value: 'run-tracking content',
      namespace,
      dbPath,
    });

    expect(result?.success).toBe(true);
    expect(result?.embedding).toBeUndefined();
    expect(embedSpy).not.toHaveBeenCalled();

    const rows = await readRows(
      'SELECT embedding, embedding_model, embedding_dimensions FROM memory_entries WHERE key = ?',
      ['k-ephemeral'],
    );
    expect(rows[0]?.embedding).toBeNull();
    expect(rows[0]?.embedding_model).toBeNull();
    expect(rows[0]?.embedding_dimensions).toBeNull();
  });

  it('drops precomputed embeddings for ephemeral namespaces (no smuggling)', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'fast-all-MiniLM-L6-v2' }));

    const result = await bridgeStoreEntry({
      key: 'k-precomp',
      value: 'spell record',
      namespace: 'tasklist',
      precomputedEmbedding: new Float32Array(384).fill(0.42),
      dbPath,
    });

    expect(result?.success).toBe(true);
    const rows = await readRows(
      'SELECT embedding, embedding_model FROM memory_entries WHERE key = ?',
      ['k-precomp'],
    );
    expect(rows[0]?.embedding).toBeNull();
    expect(rows[0]?.embedding_model).toBeNull();
  });

  it('non-ephemeral namespaces still get embedded normally', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'fast-all-MiniLM-L6-v2' }));

    const result = await bridgeStoreEntry({
      key: 'k-knowledge',
      value: 'a real knowledge entry',
      namespace: 'knowledge',
      dbPath,
    });

    expect(result?.success).toBe(true);
    expect(result?.embedding?.model).toBe('fast-all-MiniLM-L6-v2');
    const rows = await readRows(
      'SELECT embedding, embedding_model FROM memory_entries WHERE key = ?',
      ['k-knowledge'],
    );
    expect(rows[0]?.embedding).not.toBeNull();
    expect(rows[0]?.embedding_model).toBe('fast-all-MiniLM-L6-v2');
  });
});

describe('refreshVectorStatsCache — missing counter (#649)', () => {
  it('writes a `missing` field for active rows with NULL embedding', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'fast-all-MiniLM-L6-v2' }));

    // Insert one healthy row (with embedding) and two opt-out rows (without)
    await bridgeStoreEntry({ key: 'healthy', value: 'h', namespace: 'test', dbPath });
    await bridgeStoreEntry({
      key: 'skipped-1', value: 's1', namespace: 'test',
      generateEmbeddingFlag: false, dbPath,
    });
    await bridgeStoreEntry({
      key: 'skipped-2', value: 's2', namespace: 'test',
      generateEmbeddingFlag: false, dbPath,
    });

    // Fire the cache refresh explicitly so we don't race the bridge's own
    // post-store call.
    const { refreshVectorStatsCache } = await import('../memory/bridge-core.js');
    refreshVectorStatsCache(dbPath);

    const statsPath = path.join(tmpDir, '.moflo', 'vector-stats.json');
    expect(fs.existsSync(statsPath)).toBe(true);
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.vectorCount).toBe(1);
    expect(stats.missing).toBe(2);
  });
});

describe('bridgeSearchEntries — query embedder wiring (#837 Defect A)', () => {
  it("uses the bridge embedder for the query, not the missing ctx.mofloDb.embedder", async () => {
    const fixedVec = new Float32Array(384).fill(0.1);
    const embedSpy = vi.fn(async () => fixedVec);
    setBridgeEmbedderForTest({
      model: 'fast-all-MiniLM-L6-v2',
      dimensions: 384,
      embed: embedSpy,
    });

    await bridgeStoreEntry({
      key: 'probe',
      value: 'subagent reaches MCP memory store path',
      namespace: 'memdiag',
      dbPath,
    });

    const writeCalls = embedSpy.mock.calls.length;

    const result = await bridgeSearchEntries({
      query: 'totally unrelated wording about banana logistics',
      namespace: 'memdiag',
      threshold: 0,
      dbPath,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(embedSpy.mock.calls.length).toBe(writeCalls + 1);
    expect(result?.searchMethod).toBe('hybrid-bm25-semantic');
    expect(result?.results.length).toBeGreaterThan(0);
    expect(result?.results[0]?.score).toBeGreaterThan(0.6);
  });

  it("threshold: 0 returns matches even when score is below the default 0.3", async () => {
    // Orthogonal unit vectors with disjoint query terms keep total score
    // below 0.3 regardless of weighting — exercises the threshold gate, not
    // similarity ranking.
    const storeVec = new Float32Array(384);
    storeVec[0] = 1;
    const queryVec = new Float32Array(384);
    queryVec[1] = 1;

    setBridgeEmbedderForTest({
      model: 'fast-all-MiniLM-L6-v2',
      dimensions: 384,
      embed: vi.fn(async (text: string) => (text.includes('store-side') ? storeVec : queryVec)),
    });

    await bridgeStoreEntry({
      key: 'low-sim',
      value: 'store-side content with no overlap',
      namespace: 'memdiag',
      dbPath,
    });

    const filtered = await bridgeSearchEntries({
      query: 'wholly different text',
      namespace: 'memdiag',
      dbPath,
    });
    expect(filtered?.results.length).toBe(0);

    const unfiltered = await bridgeSearchEntries({
      query: 'wholly different text',
      namespace: 'memdiag',
      threshold: 0,
      dbPath,
    });
    expect(unfiltered?.results.length).toBe(1);
    expect(unfiltered?.results[0]?.key).toBe('low-sim');
  });
});
