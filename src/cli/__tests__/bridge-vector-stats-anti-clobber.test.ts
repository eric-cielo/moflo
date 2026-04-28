/**
 * Tests for the anti-clobber guard on `refreshVectorStatsCache` (#639).
 *
 * The bridge calls refreshVectorStatsCache after every store/delete. If the
 * registry's DB context is partially initialized OR the SELECT queries throw,
 * the function used to write `vectorCount=0` over a known-good cache —
 * causing the statusline to display `Vectors ●0` even though the DB had
 * thousands of embedded rows. The guard only writes zeros when there is no
 * pre-existing populated cache to preserve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  setBridgeEmbedderForTest,
  _resetBridgeEmbedderCacheForTest,
  type BridgeEmbedder,
} from '../memory/bridge-embedder.js';
import { bridgeStoreEntry } from '../memory/bridge-entries.js';
import { _resetProjectRootForTest, refreshVectorStatsCache } from '../memory/bridge-core.js';
import { shutdownBridge } from '../memory/memory-bridge.js';

class StubEmbedder implements BridgeEmbedder {
  readonly model = 'fast-all-MiniLM-L6-v2';
  readonly dimensions = 384;
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(this.dimensions).fill(0.1);
  }
}

let tmpDir: string;
let dbPath: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-vstat-clobber-'));
  fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
  process.chdir(tmpDir);
  _resetProjectRootForTest();
  dbPath = path.join(tmpDir, '.swarm', 'memory.db');
  await shutdownBridge();
});

afterEach(async () => {
  setBridgeEmbedderForTest(null);
  _resetBridgeEmbedderCacheForTest();
  await shutdownBridge();
  process.chdir(originalCwd);
  _resetProjectRootForTest();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('refreshVectorStatsCache anti-clobber guard (#639)', () => {
  it('preserves a populated cache when called with no resolved registry', () => {
    // Seed a populated stats file as if a prior write had succeeded
    const moflo = path.join(tmpDir, '.moflo');
    fs.mkdirSync(moflo, { recursive: true });
    const statsPath = path.join(moflo, 'vector-stats.json');
    fs.writeFileSync(
      statsPath,
      JSON.stringify({ vectorCount: 2936, missing: 0, dbSizeKB: 54000, namespaces: 9, hasHnsw: true }),
    );

    // Refresh fires before any registry has been initialized — must NOT
    // overwrite the existing populated cache with zeros
    refreshVectorStatsCache();

    const after = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(after.vectorCount).toBe(2936);
  });

  it('still writes when the cache is genuinely absent', async () => {
    setBridgeEmbedderForTest(new StubEmbedder());
    await bridgeStoreEntry({ key: 'x', value: 'hello world', namespace: 'test', dbPath });

    const statsPath = path.join(tmpDir, '.moflo', 'vector-stats.json');
    expect(fs.existsSync(statsPath)).toBe(true);
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.vectorCount).toBe(1);
  });
});
