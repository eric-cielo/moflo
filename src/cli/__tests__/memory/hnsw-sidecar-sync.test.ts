/**
 * Lazy HNSW sidecar reconciliation (#1384).
 *
 * Before this, every run that embedded a single row passed
 * `{ alwaysRebuild: true }` and re-inserted the entire store — quadratic in
 * store size, because `HnswLite.add()` scans every existing vector. The graph
 * also never lost the vectors of rows that had gone away: `applyIncrementalChunks`
 * gives an edited chunk a brand-new id, so each edit orphaned the old one.
 *
 * These tests pin both halves — laziness (already-indexed rows are never
 * re-added) and completeness (departed, replaced, and newly-embedded rows all
 * converge) — plus the narrow set of conditions under which a full rebuild is
 * still correct.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  buildAndWriteHnswSidecar,
  hnswManifestPath,
  syncHnswSidecar,
  tryLoadHnswSidecar,
} from '../../memory/hnsw-persistence.js';
import { HnswLite } from '../../memory/hnsw-lite.js';
import { hnswIndexPath, MOFLO_DIR, MEMORY_DB_FILE } from '../../services/moflo-paths.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

const DIM = 8;
const ROW_COUNT = 12;

function vectorFor(seed: number): number[] {
  return Array.from({ length: DIM }, (_, j) => Number(Math.sin(seed * 0.7 + j * 0.3).toFixed(6)));
}

function withDb<T>(dbPath: string, fn: (db: ReturnType<typeof openDaemonDatabase>) => T): T {
  const db = openDaemonDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedDb(dbPath: string): string[] {
  return withDb(dbPath, (db) => {
    db.run(`CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT,
      namespace TEXT,
      content TEXT,
      embedding TEXT,
      updated_at INTEGER,
      status TEXT
    )`);

    const ids: string[] = [];
    for (let i = 0; i < ROW_COUNT; i++) {
      const id = `row-${i.toString().padStart(3, '0')}`;
      ids.push(id);
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, embedding, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [id, `key-${i}`, 'patterns', `content ${i}`, JSON.stringify(vectorFor(i)), 1_700_000_000_000],
      );
    }
    return ids;
  });
}

function insertRow(dbPath: string, id: string, key: string, embedding: number[] | null): void {
  withDb(dbPath, (db) => {
    db.run(
      `INSERT INTO memory_entries (id, key, namespace, content, embedding, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [
        id, key, 'patterns', `content for ${key}`,
        embedding === null ? null : JSON.stringify(embedding),
        1_700_000_000_000,
      ],
    );
  });
}

function sidecarIds(projectRoot: string): string[] {
  const loaded = tryLoadHnswSidecar(projectRoot);
  return loaded ? [...loaded.ids()] : [];
}

describe('hnsw-persistence — syncHnswSidecar (#1384)', () => {
  let tmp: string;
  let dbPath: string;
  let ids: string[];

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1384-'));
    fs.mkdirSync(path.join(tmp, MOFLO_DIR));
    dbPath = path.join(tmp, MOFLO_DIR, MEMORY_DB_FILE);
    ids = seedDb(dbPath);
    // Establish the baseline sidecar every laziness assertion measures against.
    await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('laziness — already-indexed rows are left alone', () => {
    it('writes nothing at all when the DB has not changed', async () => {
      const serialize = vi.spyOn(HnswLite.prototype, 'serialize');
      const add = vi.spyOn(HnswLite.prototype, 'add');

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.mode).toBe('unchanged');
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.bytes).toBe(0);
      expect(result.vectorCount).toBe(ROW_COUNT);
      expect(add).not.toHaveBeenCalled();
      expect(serialize).not.toHaveBeenCalled();
    });

    it('embedding one new row touches only that row', async () => {
      insertRow(dbPath, 'row-new', 'key-new', vectorFor(99));
      const add = vi.spyOn(HnswLite.prototype, 'add');

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.mode).toBe('incremental');
      expect(result.added).toBe(1);
      expect(result.removed).toBe(0);
      // The whole point: 1 insertion, not ROW_COUNT + 1.
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0][0]).toBe('row-new');
      expect(sidecarIds(tmp).sort()).toEqual([...ids, 'row-new'].sort());
    });
  });

  describe('completeness — every divergence converges', () => {
    it('evicts the old chunk id when a doc is edited (no orphan accumulation)', async () => {
      // Exactly what applyIncrementalChunks does to a changed chunk: same key,
      // brand-new id.
      withDb(dbPath, (db) => {
        db.run(`DELETE FROM memory_entries WHERE id = ?`, [ids[3]]);
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, embedding, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
          [
            'row-003-edited', 'key-3', 'patterns', 'edited content',
            JSON.stringify(vectorFor(42)), 1_700_000_000_001,
          ],
        );
      });

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.mode).toBe('incremental');
      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
      const after = sidecarIds(tmp);
      expect(after).not.toContain(ids[3]);
      expect(after).toContain('row-003-edited');
      expect(after).toHaveLength(ROW_COUNT);
    });

    it('drops a deleted row from the graph', async () => {
      withDb(dbPath, (db) => db.run(`DELETE FROM memory_entries WHERE id = ?`, [ids[0]]));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.removed).toBe(1);
      expect(sidecarIds(tmp)).not.toContain(ids[0]);
    });

    it('drops a row whose embedding was cleared', async () => {
      withDb(dbPath, (db) =>
        db.run(`UPDATE memory_entries SET embedding = NULL WHERE id = ?`, [ids[1]]));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.removed).toBe(1);
      expect(sidecarIds(tmp)).not.toContain(ids[1]);
    });

    it('replaces the vector when a row is re-embedded under the SAME id', async () => {
      // bridgeAddToHNSW, the embeddings migration, and build-embeddings all
      // UPDATE ... WHERE id = ?. An id-only diff would call this "already
      // indexed" and keep serving the superseded vector.
      const replacement = vectorFor(500);
      withDb(dbPath, (db) =>
        db.run(`UPDATE memory_entries SET embedding = ? WHERE id = ?`,
          [JSON.stringify(replacement), ids[2]]));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.mode).toBe('incremental');
      expect(result.added).toBe(1);
      expect(result.vectorCount).toBe(ROW_COUNT);

      const loaded = tryLoadHnswSidecar(tmp)!;
      const hits = loaded.search(new Float32Array(replacement), 1);
      expect(hits[0].id).toBe(ids[2]);
      expect(hits[0].score).toBeGreaterThan(0.999);
    });

    it('re-adds a row whose updated_at moved, even if the embedding text looks the same', async () => {
      // Second, independent discriminator in the stamp: a writer that rewrites
      // an embedding is caught by `updated_at` even in the (vanishingly rare)
      // case where length and leading floats coincide.
      withDb(dbPath, (db) =>
        db.run(`UPDATE memory_entries SET updated_at = ? WHERE id = ?`, [1_700_000_009_999, ids[6]]));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.mode).toBe('incremental');
      expect(result.added).toBe(1);
      expect(result.vectorCount).toBe(ROW_COUNT);
    });

    it('keeps the graph searchable for rows added incrementally', async () => {
      const fresh = vectorFor(777);
      insertRow(dbPath, 'row-fresh', 'key-fresh', fresh);
      await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      const loaded = tryLoadHnswSidecar(tmp)!;
      const hits = loaded.search(new Float32Array(fresh), 1);
      expect(hits[0].id).toBe('row-fresh');
    });
  });

  describe('full rebuild — only when reconciliation cannot be trusted', () => {
    it('force rebuilds from scratch and says so', async () => {
      const add = vi.spyOn(HnswLite.prototype, 'add');

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM, force: true });

      expect(result.mode).toBe('full');
      expect(result.reason).toBe('forced');
      expect(add).toHaveBeenCalledTimes(ROW_COUNT);
    });

    it('rebuilds when the sidecar is absent', async () => {
      fs.rmSync(hnswIndexPath(tmp));
      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('no sidecar');
      expect(result.vectorCount).toBe(ROW_COUNT);
    });

    it('rebuilds when the sidecar is unreadable', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(hnswIndexPath(tmp), Buffer.from('NOT A SIDECAR'));
      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('sidecar unreadable');
    });

    it('rebuilds when the manifest is missing — the upgrade path', async () => {
      fs.rmSync(hnswManifestPath(tmp));
      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('no usable manifest');
      // …and one rebuild is all it costs: the next run is incremental again.
      expect((await syncHnswSidecar(dbPath, tmp, { dimensions: DIM })).mode).toBe('unchanged');
    });

    it('rebuilds when the manifest no longer describes the sidecar', async () => {
      const manifest = JSON.parse(fs.readFileSync(hnswManifestPath(tmp), 'utf-8'));
      manifest.ids[0] = 'an-id-the-sidecar-has-never-heard-of';
      fs.writeFileSync(hnswManifestPath(tmp), JSON.stringify(manifest));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('manifest does not match sidecar');
    });

    it('rebuilds when the manifest is corrupt', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(hnswManifestPath(tmp), '{ not json');
      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('no usable manifest');
    });

    it('rebuilds when the requested index parameters differ from the stored ones', async () => {
      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM, m: 32 });
      expect(result.mode).toBe('full');
      expect(result.reason).toBe('index parameters changed');
    });

    it('buildAndWriteHnswSidecar leaves a manifest, so an explicit rebuild stays reconcilable', async () => {
      fs.rmSync(hnswManifestPath(tmp));
      await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });
      expect(fs.existsSync(hnswManifestPath(tmp))).toBe(true);
      expect((await syncHnswSidecar(dbPath, tmp, { dimensions: DIM })).mode).toBe('unchanged');
    });
  });

  describe('malformed embeddings are surfaced, not silently dropped', () => {
    it('reports the id of a new row whose embedding will not parse', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withDb(dbPath, (db) =>
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, embedding, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
          ['row-broken', 'key-broken', 'patterns', 'x', 'not-json-at-all', 1_700_000_000_000],
        ));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.skippedIds).toEqual(['row-broken']);
      expect(result.added).toBe(0);
      expect(sidecarIds(tmp)).not.toContain('row-broken');
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('row-broken');
    });

    it('reports and evicts an indexed row whose embedding became wrong-dimension', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      withDb(dbPath, (db) =>
        db.run(`UPDATE memory_entries SET embedding = ? WHERE id = ?`,
          [JSON.stringify([1, 2, 3]), ids[4]]));

      const result = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.skippedIds).toEqual([ids[4]]);
      expect(result.removed).toBe(1);
      expect(sidecarIds(tmp)).not.toContain(ids[4]);
    });

    it('names skipped rows on the full-rebuild path too', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withDb(dbPath, (db) =>
        db.run(`UPDATE memory_entries SET embedding = ? WHERE id = ?`,
          [JSON.stringify([1, 2, 3]), ids[5]]));

      const result = await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(result.skippedIds).toEqual([ids[5]]);
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain(ids[5]);
    });
  });

  it('throws when the source DB is missing — fail-loud parity with the rebuild path', async () => {
    await expect(
      syncHnswSidecar(path.join(tmp, 'nope.db'), tmp, { dimensions: DIM }),
    ).rejects.toThrow(/db not found/);
  });
});

describe('hnsw-persistence — chain wiring (#1384 regression guard)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  it('`memory rebuild-index` reconciles by default and only rebuilds under --force', () => {
    // The session-start chain runs `build-embeddings` and then
    // `memory rebuild-index`. Both write the sidecar, so leaving either on the
    // wholesale-rebuild path costs a full re-index every session no matter
    // what the other one does.
    const file = path.join(repoRoot, 'src', 'cli', 'commands', 'memory.ts');
    const text = fs.readFileSync(file, 'utf-8');
    const fn = text.match(/const\s+writeSidecarOrFail\s*=[\s\S]*?\n {4}\};/);
    expect(fn, 'writeSidecarOrFail must exist').toBeTruthy();
    expect(fn![0]).toMatch(/syncHnswSidecar\(dbPath,\s*cwd,\s*\{\s*force:\s*forceAll\s*\}\)/);
    expect(fn![0]).not.toMatch(/buildAndWriteHnswSidecar/);
  });
});
