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
import { bridgeDeleteEntry, bridgeGetEntry, bridgeListEntries, bridgeSearchEntries, bridgeStoreEntries, bridgeStoreEntry } from '../memory/bridge-entries.js';
import { _resetProjectRootForTest, execRows, getDb, persistBridgeDb, tryPersistBridgeDb } from '../memory/bridge-core.js';
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

describe('bridgeDeleteEntry — error surfacing (#963)', () => {
  it('successfully deletes an existing entry and removes it from list', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    await bridgeStoreEntry({
      key: 'k-delete-me',
      value: 'goodbye',
      namespace: 'scheduled-spells',
      dbPath,
    });

    const before = await bridgeListEntries({ namespace: 'scheduled-spells', dbPath });
    expect(before?.entries.find(e => e.key === 'k-delete-me')).toBeDefined();

    const result = await bridgeDeleteEntry({
      key: 'k-delete-me',
      namespace: 'scheduled-spells',
      dbPath,
    });

    expect(result?.success).toBe(true);
    expect(result?.deleted).toBe(true);
    expect(result?.error).toBeUndefined();

    const after = await bridgeListEntries({ namespace: 'scheduled-spells', dbPath });
    expect(after?.entries.find(e => e.key === 'k-delete-me')).toBeUndefined();
  });

  it('returns success:false with a key-not-found error when the key does not exist', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const result = await bridgeDeleteEntry({
      key: 'never-existed',
      namespace: 'scheduled-spells',
      dbPath,
    });

    expect(result?.success).toBe(false);
    expect(result?.deleted).toBe(false);
    expect(result?.error).toBe("Key 'never-existed' not found in namespace 'scheduled-spells'");
  });

  it('returns success:false with a key-not-found error when the namespace is wrong', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    await bridgeStoreEntry({
      key: 'k-ns-test',
      value: 'in-correct-ns',
      namespace: 'correct-ns',
      dbPath,
    });

    const result = await bridgeDeleteEntry({
      key: 'k-ns-test',
      namespace: 'wrong-ns',
      dbPath,
    });

    expect(result?.success).toBe(false);
    expect(result?.deleted).toBe(false);
    expect(result?.error).toContain('not found in namespace');
    expect(result?.error).toContain('wrong-ns');

    // Original entry still in correct namespace
    const list = await bridgeListEntries({ namespace: 'correct-ns', dbPath });
    expect(list?.entries.find(e => e.key === 'k-ns-test')).toBeDefined();
  });
});

// ===========================================================================
// #982 — bridge persist failures must NOT be silently swallowed.
//
// Repros the silent-data-loss pattern: pre-#982 the inner sql.js insert
// succeeded but `atomicWriteFileSync` threw (EBUSY on Windows when another
// process held the dbfile open, ENOSPC, perm denied), the throw was logged
// once to stderr, and `bridgeStoreEntry` returned `{ success: true }`. Every
// caller upstream (memory-initializer.storeEntry, dashboard accessor,
// runner.storeProgress) trusted the success and the data died with the
// process. Same pattern in `bridgeStoreEntries` and `bridgeDeleteEntry`.
// ===========================================================================
describe('#982 — persist failures surface as success:false', () => {
  /** Inject EBUSY into the rename leg of atomicWriteFileSync. */
  function makeRenameThrow(): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error('EBUSY: resource busy or locked, rename');
    err.code = 'EBUSY';
    return err;
  }

  it('persistBridgeDb rethrows the underlying error (no silent swallow)', () => {
    const fakeDb = { export: () => { throw makeRenameThrow(); } };
    expect(() => persistBridgeDb(fakeDb, dbPath)).toThrow(/EBUSY/);
  });

  it('tryPersistBridgeDb returns ok:false instead of throwing', () => {
    const fakeDb = { export: () => { throw makeRenameThrow(); } };
    const result = tryPersistBridgeDb(fakeDb, dbPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/EBUSY/);
    }
  });

  /**
   * Override the bridge db's persist call to throw. Returns a restore fn.
   *
   * Under sql.js the persist path is `atomicWriteFileSync(target, db.export())`
   * so injecting on `.export()` covers it. Under node:sqlite + WAL (Phase 4
   * default) persistBridgeDb routes to `db.save()` instead — patch both so
   * the contract test stays engine-agnostic.
   *
   * Direct method assignment (not vi.spyOn) because ESM namespace bindings
   * aren't configurable and the bridge db is plain object-with-methods.
   */
  async function injectPersistFailure(err: Error): Promise<() => void> {
    const reg = await getControllerRegistry(dbPath);
    if (!reg) throw new Error('test bridge registry unavailable');
    const ctx = getDb(reg);
    if (!ctx) throw new Error('test bridge db ctx unavailable');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = ctx.db;
    const origExport = typeof db.export === 'function' ? db.export.bind(db) : null;
    const origSave = typeof db.save === 'function' ? db.save.bind(db) : null;
    if (origExport) db.export = () => { throw err; };
    if (origSave) db.save = () => { throw err; };
    return () => {
      if (origExport) db.export = origExport;
      if (origSave) db.save = origSave;
    };
  }

  it('bridgeStoreEntry returns success:false with persist failed when atomic-write throws', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Land one successful row first so the bridge is fully initialized
    // (registry + embedder cache warm) before we inject the failure. This
    // mirrors the real-world reproduction: short-lived `flo epic` runs
    // start with a healthy DB, then hit EBUSY on a later persist.
    const ok = await bridgeStoreEntry({ key: 'pre-fail', value: 'baseline', namespace: 'tasklist', dbPath });
    expect(ok?.success).toBe(true);

    const restore = await injectPersistFailure(makeRenameThrow());
    try {
      const result = await bridgeStoreEntry({
        key: 'should-fail',
        value: 'data that never reaches disk',
        namespace: 'tasklist',
        dbPath,
      });
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('persist failed');
      expect(result?.error).toMatch(/EBUSY/);
    } finally {
      restore();
    }
  });

  it('bridgeStoreEntries flips ALL successful results to failed when the final persist throws', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Warm the bridge with a successful baseline write
    const ok = await bridgeStoreEntry({ key: 'warm-up', value: 'x', namespace: 'tasklist', dbPath });
    expect(ok?.success).toBe(true);

    const restore = await injectPersistFailure(makeRenameThrow());
    try {
      const results = await bridgeStoreEntries(
        [
          { key: 'batch-1', value: 'a', namespace: 'tasklist' },
          { key: 'batch-2', value: 'b', namespace: 'tasklist' },
          { key: 'batch-3', value: 'c', namespace: 'tasklist' },
        ],
        dbPath,
      );
      expect(results).not.toBeNull();
      expect(results).toHaveLength(3);
      // sql.js dumps the entire DB snapshot in one persist call, so a single
      // throw means NONE of the batch reached disk — every entry must report
      // persist failed, regardless of how its inserts went in RAM.
      for (const r of results!) {
        expect(r.success).toBe(false);
        expect(r.error).toContain('persist failed');
      }
    } finally {
      restore();
    }
  });

  it('bridgeDeleteEntry returns success:false with persist failed when atomic-write throws', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Insert the row to be deleted
    const inserted = await bridgeStoreEntry({
      key: 'k-to-delete',
      value: 'doomed',
      namespace: 'scheduled-spells',
      dbPath,
    });
    expect(inserted?.success).toBe(true);

    const restore = await injectPersistFailure(makeRenameThrow());
    try {
      const result = await bridgeDeleteEntry({
        key: 'k-to-delete',
        namespace: 'scheduled-spells',
        dbPath,
      });
      expect(result?.success).toBe(false);
      expect(result?.deleted).toBe(false);
      expect(result?.error).toContain('persist failed');
      expect(result?.error).toMatch(/EBUSY/);
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// #994 — post-persist bookkeeping failures must NOT downgrade success.
//
// `bridgeStoreEntry` runs `tryPersist()` first (atomic write → disk), then
// performs observability steps: cache warm, attestation log, statusline
// stats. Pre-#994 a throw in any of those propagated through `withDb`'s
// catch and made the bridge return `null`, prompting `storeEntry` to fall
// back to raw sql.js. The fallback then collided with the bridge's already-
// persisted row on UNIQUE constraint and the CLI exited 1 — even though
// `memory retrieve` could find the value moments later. The Ubuntu signature
// of issue #994 in CI.
// ===========================================================================
describe('#994 — post-persist bookkeeping failures stay non-fatal', () => {
  /**
   * Stub the tieredCache controller's `set` to throw. Mirrors the production
   * failure mode: a post-persist `cacheSet` raises, the row is already on
   * disk, but the throw used to propagate.
   */
  async function injectCacheSetFailure(err: Error): Promise<() => void> {
    const reg = await getControllerRegistry(dbPath);
    if (!reg) throw new Error('test bridge registry unavailable');
    const cache = reg.get('tieredCache');
    if (!cache) throw new Error('test bridge tieredCache unavailable');
    const origSet = cache.set.bind(cache);
    cache.set = async () => { throw err; };
    return () => { cache.set = origSet; };
  }

  it('bridgeStoreEntry still returns success:true when cacheSet throws after persist', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Warm the bridge so the registry + tieredCache are resolved
    const warm = await bridgeStoreEntry({ key: 'warm', value: 'baseline', namespace: 'test', dbPath });
    expect(warm?.success).toBe(true);

    const restore = await injectCacheSetFailure(new Error('synthetic cache write failure'));
    try {
      const result = await bridgeStoreEntry({
        key: 'k-bookkeeping-fail',
        value: 'data IS on disk',
        namespace: 'test',
        dbPath,
      });
      expect(result?.success).toBe(true);
      expect(result?.cached).toBe(false);

      // The retrieve-equivalent: the row is on disk and queryable. This is
      // the exact invariant Ubuntu CI proved (memory-retrieve passed) but
      // the CLI's exit code lied because the bookkeeping throw cascaded.
      const rows = await readRows('SELECT content FROM memory_entries WHERE key = ?', ['k-bookkeeping-fail']);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe('data IS on disk');
    } finally {
      restore();
    }
  });

  it('bridgeStoreEntries reports per-row success when batch bookkeeping throws after persist', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Warm-up entry so registry is fully initialized
    const warm = await bridgeStoreEntry({ key: 'warm', value: 'x', namespace: 'test', dbPath });
    expect(warm?.success).toBe(true);

    const restore = await injectCacheSetFailure(new Error('synthetic batch cache failure'));
    try {
      const results = await bridgeStoreEntries(
        [
          { key: 'batch-a', value: '1', namespace: 'test' },
          { key: 'batch-b', value: '2', namespace: 'test' },
        ],
        dbPath,
      );
      expect(results).not.toBeNull();
      expect(results).toHaveLength(2);
      for (const r of results!) {
        expect(r.success).toBe(true);
      }

      // All rows reached disk; durable storage must be observable.
      const rows = await readRows(
        "SELECT key FROM memory_entries WHERE namespace = 'test' AND key LIKE 'batch-%' ORDER BY key",
      );
      expect(rows.map(r => r.key)).toEqual(['batch-a', 'batch-b']);
    } finally {
      restore();
    }
  });
});

describe('bridgeGetEntry — no-row detection (#998)', () => {
  it('returns found:false when the (namespace,key) pair does not exist', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Seed one unrelated row so the table exists and the SELECT actually
    // executes — the bug we're guarding is "SELECT returns no row but
    // bridgeGetEntry treats it as found", not "table is empty".
    await bridgeStoreEntry({ key: 'present', value: 'v', namespace: 'test', dbPath });

    const result = await bridgeGetEntry({
      key: 'absent-key',
      namespace: 'test',
      dbPath,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.found).toBe(false);
    expect(result?.entry).toBeUndefined();
  });

  it('never returns an entry whose id or key is the literal string "undefined"', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    // Cross-namespace miss: row exists for namespace 'test' but caller queries
    // 'other'. Pre-fix this returned a synthetic { id: "undefined", key:
    // "undefined", namespace: "default", content: "", accessCount: 1 } per the
    // smoke-harness failure dump in #998.
    await bridgeStoreEntry({ key: 'k1', value: 'v1', namespace: 'test', dbPath });

    const result = await bridgeGetEntry({
      key: 'k1',
      namespace: 'other',
      dbPath,
    });

    expect(result?.found).toBe(false);
    expect(result?.entry).toBeUndefined();
  });

  it('returns the real row when the (namespace,key) pair exists', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    await bridgeStoreEntry({
      key: 'present-key',
      value: 'present-value',
      namespace: 'test',
      dbPath,
    });

    const result = await bridgeGetEntry({
      key: 'present-key',
      namespace: 'test',
      dbPath,
    });

    expect(result?.success).toBe(true);
    expect(result?.found).toBe(true);
    expect(result?.entry?.key).toBe('present-key');
    expect(result?.entry?.content).toBe('present-value');
    expect(result?.entry?.namespace).toBe('test');
    expect(result?.entry?.id).not.toBe('undefined');
  });
});

describe('bridgeStoreEntry — metadata column round-trip (#1064)', () => {
  it('persists a plain-object metadata blob to the metadata column', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const meta = {
      type: 'chunk',
      parentDoc: 'doc-1064',
      chunkIndex: 1,
      totalChunks: 3,
      prevChunk: 'k0',
      nextChunk: 'k2',
      siblings: ['k0', 'k1', 'k2'],
    };

    const store = await bridgeStoreEntry({
      key: 'k1',
      value: 'chunk body',
      namespace: 'meta-test',
      metadata: meta,
      dbPath,
    });
    expect(store?.success).toBe(true);

    const rows = await readRows(
      `SELECT metadata FROM memory_entries WHERE namespace = ? AND key = ?`,
      ['meta-test', 'k1'],
    );
    expect(rows.length).toBe(1);
    expect(JSON.parse(String(rows[0].metadata))).toMatchObject(meta);
  });

  it('accepts a pre-stringified JSON blob and stores it verbatim', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const raw = JSON.stringify({ type: 'chunk', parentDoc: 'd', chunkIndex: 0 });
    await bridgeStoreEntry({
      key: 'k-raw',
      value: 'v',
      namespace: 'meta-test',
      metadata: raw,
      dbPath,
    });

    const rows = await readRows(
      `SELECT metadata FROM memory_entries WHERE namespace = ? AND key = ?`,
      ['meta-test', 'k-raw'],
    );
    expect(String(rows[0].metadata)).toBe(raw);
  });

  it('defaults to {} when metadata is omitted (matches pre-#1064 shape)', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    await bridgeStoreEntry({
      key: 'k-omit',
      value: 'v',
      namespace: 'meta-test',
      dbPath,
    });

    const rows = await readRows(
      `SELECT metadata FROM memory_entries WHERE namespace = ? AND key = ?`,
      ['meta-test', 'k-omit'],
    );
    expect(String(rows[0].metadata)).toBe('{}');
  });

  it('surfaces metadata through bridgeGetEntry on the same row', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const meta = { type: 'chunk', parentDoc: 'd', chunkTitle: 'T' };
    await bridgeStoreEntry({
      key: 'k-get',
      value: 'v',
      namespace: 'meta-test',
      metadata: meta,
      dbPath,
    });

    const got = await bridgeGetEntry({ key: 'k-get', namespace: 'meta-test', dbPath });
    expect(got?.success).toBe(true);
    expect(got?.found).toBe(true);
    expect(got?.entry?.metadata).toBeDefined();
    expect(JSON.parse(String(got?.entry?.metadata))).toMatchObject(meta);
  });

  it('persists per-item metadata through bridgeStoreEntries (batch)', async () => {
    setBridgeEmbedderForTest(new StubEmbedder({ model: 'm', dimensions: 384 }));

    const items = [
      { key: 'b0', value: 'v0', namespace: 'meta-test', metadata: { type: 'chunk', chunkIndex: 0 } },
      { key: 'b1', value: 'v1', namespace: 'meta-test', metadata: { type: 'chunk', chunkIndex: 1 } },
      { key: 'b2', value: 'v2', namespace: 'meta-test' /* defaults to '{}' */ },
    ];
    const results = await bridgeStoreEntries(items, dbPath);
    expect(results?.every(r => r.success)).toBe(true);

    const rows = await readRows(
      `SELECT key, metadata FROM memory_entries WHERE namespace = ? ORDER BY key`,
      ['meta-test'],
    );
    expect(rows.length).toBe(3);
    expect(JSON.parse(String(rows[0].metadata))).toMatchObject({ type: 'chunk', chunkIndex: 0 });
    expect(JSON.parse(String(rows[1].metadata))).toMatchObject({ type: 'chunk', chunkIndex: 1 });
    expect(String(rows[2].metadata)).toBe('{}');
  });
});
