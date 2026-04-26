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
import { bridgeStoreEntry } from '../memory/bridge-entries.js';
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
  // (.claude-flow/vector-stats.json). Isolate so tests don't clobber the
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

    const statsPath = path.join(tmpDir, '.claude-flow', 'vector-stats.json');
    expect(fs.existsSync(statsPath)).toBe(true);
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.vectorCount).toBe(1);
    expect(stats.missing).toBe(2);
  });
});
