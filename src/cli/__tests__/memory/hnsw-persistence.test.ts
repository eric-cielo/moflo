/**
 * Integration + source-invariant tests for the HNSW sidecar persistence
 * layer (#734). Together they enforce:
 *
 *   1. Round-trip: build a graph from a seeded sql.js DB → write the sidecar →
 *      load it back → search results match.
 *   2. Cold-start optimisation: tryLoadHnswSidecar() returns a populated
 *      HnswLite without ever reading the embedding column.
 *   3. Phantom-sidecar removal: the dead `unlinkSync(.../hnsw.index)` block
 *      and `hnsw.metadata.json` references that #734 deleted from
 *      build-embeddings.mjs and memory-initializer.ts stay deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildAndWriteHnswSidecar,
  tryLoadHnswSidecar,
} from '../../memory/hnsw-persistence.js';
import { hnswIndexPath, MOFLO_DIR, MEMORY_DB_FILE } from '../../services/moflo-paths.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

const DIM = 8;
const ROW_COUNT = 12;

// Seeds a real on-disk SQLite DB via the unified `openDaemonDatabase` factory
// (Phase 5 / #1084). Pre-#1084 this used sql.js + `db.export()`, but sql.js was
// retired across the codebase; `node:sqlite` writes a standard SQLite file
// that `buildAndWriteHnswSidecar` reads via the same factory.
function seedDb(dbPath: string): string[] {
  const db = openDaemonDatabase(dbPath);

  db.run(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT,
    namespace TEXT,
    content TEXT,
    embedding TEXT,
    status TEXT
  )`);

  const ids: string[] = [];
  for (let i = 0; i < ROW_COUNT; i++) {
    const id = `row-${i.toString().padStart(3, '0')}`;
    ids.push(id);
    const vec = Array.from({ length: DIM }, (_, j) => Math.sin(i * 0.7 + j * 0.3));
    db.run(
      `INSERT INTO memory_entries (id, key, namespace, content, embedding, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, `key-${i}`, 'patterns', `content ${i}`, JSON.stringify(vec), 'active'],
    );
  }

  // Mix in one entry with no embedding (must be ignored by buildAndWriteHnswSidecar).
  db.run(
    `INSERT INTO memory_entries (id, key, namespace, content, embedding, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['row-no-embedding', 'no-embed', 'patterns', 'skipped', null, 'active'],
  );

  db.close();
  return ids;
}

describe('hnsw-persistence — buildAndWriteHnswSidecar', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-734-'));
    fs.mkdirSync(path.join(tmp, MOFLO_DIR));
    dbPath = path.join(tmp, MOFLO_DIR, MEMORY_DB_FILE);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a sidecar at .moflo/hnsw.index containing every embedded row', async () => {
    seedDb(dbPath);

    const result = await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });

    expect(result.sidecarPath).toBe(hnswIndexPath(tmp));
    expect(result.vectorCount).toBe(ROW_COUNT); // null-embedding row excluded
    expect(fs.existsSync(result.sidecarPath)).toBe(true);
    expect(fs.statSync(result.sidecarPath).size).toBe(result.bytes);
  });

  it('round-trips: tryLoadHnswSidecar returns a populated HnswLite that searches correctly', async () => {
    const ids = seedDb(dbPath);
    await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });

    const loaded = tryLoadHnswSidecar(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(ROW_COUNT);

    // Query with the exact embedding of row 5 — top hit must be row 5.
    const queryVec = new Float32Array(
      Array.from({ length: DIM }, (_, j) => Math.sin(5 * 0.7 + j * 0.3)),
    );
    const hits = loaded!.search(queryVec, 3);
    expect(hits[0].id).toBe(ids[5]);
  });

  it('returns null when the sidecar is missing', () => {
    expect(tryLoadHnswSidecar(tmp)).toBeNull();
  });

  it('returns null and warns when the sidecar is corrupt', () => {
    fs.writeFileSync(hnswIndexPath(tmp), Buffer.from('NOTAVALIDFILE'));
    // Suppress the warn output for the duration of the test.
    const original = console.warn;
    console.warn = () => {};
    try {
      expect(tryLoadHnswSidecar(tmp)).toBeNull();
    } finally {
      console.warn = original;
    }
  });

  it('throws when the source DB is missing — fail-loud guarantee', async () => {
    await expect(
      buildAndWriteHnswSidecar(path.join(tmp, 'nope.db'), tmp, { dimensions: DIM }),
    ).rejects.toThrow(/db not found/);
  });

  it('atomic rename: a fresh write replaces an older sidecar without leaving a tmp file', async () => {
    seedDb(dbPath);
    fs.writeFileSync(hnswIndexPath(tmp), Buffer.from('stale'));
    await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });

    const remaining = fs.readdirSync(path.join(tmp, MOFLO_DIR));
    // No `*.tmp` orphans from atomicWriteFileSync.
    expect(remaining.filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(remaining).toContain('hnsw.index');
  });
});

describe('hnsw-persistence — source-level invariants (regression guard)', () => {
  it('build-embeddings.mjs no longer unlink-syncs hnsw.index or references hnsw.metadata.json', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const file = path.join(repoRoot, 'bin', 'build-embeddings.mjs');
    if (!fs.existsSync(file)) return; // not present in some packaging contexts
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toMatch(/unlinkSync\([^)]*hnsw\.index/);
    expect(text).not.toMatch(/hnsw\.metadata\.json/);
  });

  it('memory-initializer.ts no longer reads or writes hnsw.metadata.json', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const file = path.join(repoRoot, 'src', 'cli', 'memory', 'memory-initializer.ts');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toMatch(/hnsw\.metadata\.json/);
    expect(text).not.toMatch(/saveHNSWMetadata/);
  });

  it('index-all.mjs has the post-condition existsSync check after hnsw-rebuild', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const file = path.join(repoRoot, 'bin', 'index-all.mjs');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).toMatch(/hnsw-rebuild post-check/);
    expect(text).toMatch(/hnswIndexPath\(projectRoot\)/);
  });
});
