/**
 * End-to-end laziness across the two halves of the indexing chain (#1384).
 *
 * `applyIncrementalChunks` (#1057) is already lazy at the DB layer: unchanged
 * chunks keep their embedding, a changed chunk is rewritten under a BRAND-NEW
 * id, and departed chunks are deleted. The sidecar was not — it was rebuilt
 * wholesale on every run, which both cost a full re-index per session and
 * masked the fact that nothing ever evicted the ids the DB layer had retired.
 *
 * This test drives the real sequence a doc edit produces — index, edit one
 * section and append another, re-index, embed only the rows that lost their
 * vector, reconcile — and pins that the sidecar ends up agreeing with the DB
 * while touching only the rows that actually changed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyIncrementalChunks } from '../../bin/lib/incremental-write.mjs';
import { syncHnswSidecar, tryLoadHnswSidecar } from '../../src/cli/memory/hnsw-persistence.js';
import { HnswLite } from '../../src/cli/memory/hnsw-lite.js';
import { MOFLO_DIR, MEMORY_DB_FILE } from '../../src/cli/services/moflo-paths.js';

const DIM = 8;
const NS = 'guidance';

function vectorFor(seed: number): number[] {
  return Array.from({ length: DIM }, (_, j) => Number(Math.sin(seed * 0.9 + j * 0.4).toFixed(6)));
}

async function openWriter(dbPath: string) {
  const { openBackend } = await import('../../bin/lib/get-backend.mjs');
  return openBackend(process.cwd(), { dbPath });
}

async function createSchema(dbPath: string): Promise<void> {
  const db = await openWriter(dbPath);
  db.run(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'semantic',
      embedding TEXT,
      embedding_model TEXT DEFAULT 'local',
      embedding_dimensions INTEGER,
      tags TEXT,
      metadata TEXT,
      owner_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      UNIQUE(namespace, key)
    )
  `);
  db.close();
}

/** Re-index a doc's chunks the way the guidance indexer does. */
async function reindex(dbPath: string, chunks: Array<{ key: string; content: string }>) {
  const db = await openWriter(dbPath);
  const counts = applyIncrementalChunks(db, NS, chunks);
  db.close();
  return counts;
}

/**
 * Stand-in for build-embeddings: vectorise exactly the rows that lack an
 * embedding, keyed off content so a chunk's vector is a function of its text.
 */
async function embedMissing(dbPath: string): Promise<string[]> {
  const db = await openWriter(dbPath);
  const stmt = db.prepare(
    `SELECT id, content FROM memory_entries
      WHERE status = 'active' AND (embedding IS NULL OR embedding = '')`,
  );
  const pending: Array<{ id: string; content: string }> = [];
  while (stmt.step()) pending.push(stmt.getAsObject() as { id: string; content: string });
  stmt.free();

  for (const { id, content } of pending) {
    db.run(
      `UPDATE memory_entries SET embedding = ?, embedding_dimensions = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(vectorFor(content.length)), DIM, Date.now(), id],
    );
  }
  db.close();
  return pending.map(p => p.id);
}

async function idsByKey(dbPath: string): Promise<Map<string, string>> {
  const db = await openWriter(dbPath);
  const stmt = db.prepare(`SELECT key, id FROM memory_entries WHERE namespace = ?`);
  stmt.bind([NS]);
  const out = new Map<string, string>();
  while (stmt.step()) {
    const row = stmt.getAsObject() as { key: string; id: string };
    out.set(row.key, row.id);
  }
  stmt.free();
  db.close();
  return out;
}

describe('doc edit → re-index → sidecar reconciliation (#1384)', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('adds the appended section, retires the edited chunk, and leaves the rest untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moflo-1384-chain-'));
    roots.push(root);
    mkdirSync(join(root, MOFLO_DIR));
    const dbPath = join(root, MOFLO_DIR, MEMORY_DB_FILE);
    await createSchema(dbPath);

    // ── Session 1: index the doc and embed it ────────────────────────────
    await reindex(dbPath, [
      { key: 'chunk-intro', content: 'intro' },
      { key: 'chunk-body', content: 'body text' },
      { key: 'chunk-outro', content: 'outro paragraph!' },
    ]);
    await embedMissing(dbPath);

    const first = await syncHnswSidecar(dbPath, root, { dimensions: DIM });
    expect(first.mode).toBe('full');
    expect(first.vectorCount).toBe(3);

    const before = await idsByKey(dbPath);

    // ── Session 2: edit one section, append another ──────────────────────
    const counts = await reindex(dbPath, [
      { key: 'chunk-intro', content: 'intro' },                    // unchanged
      { key: 'chunk-body', content: 'body text, revised again' },  // edited
      { key: 'chunk-outro', content: 'outro paragraph!' },         // unchanged
      { key: 'chunk-appendix', content: 'a freshly appended section' }, // new
    ]);
    expect(counts).toMatchObject({ inserted: 1, updated: 1, unchanged: 2, removed: 0 });

    // The DB layer's laziness: only the edited + new chunks lost their vector.
    const needEmbedding = await embedMissing(dbPath);
    expect(needEmbedding).toHaveLength(2);

    const after = await idsByKey(dbPath);
    expect(after.get('chunk-intro')).toBe(before.get('chunk-intro'));
    expect(after.get('chunk-outro')).toBe(before.get('chunk-outro'));
    // The load-bearing detail — an edited chunk keeps its key but gets a new id.
    expect(after.get('chunk-body')).not.toBe(before.get('chunk-body'));

    // ── Reconcile ────────────────────────────────────────────────────────
    const add = vi.spyOn(HnswLite.prototype, 'add');
    const second = await syncHnswSidecar(dbPath, root, { dimensions: DIM });

    expect(second.mode).toBe('incremental');
    expect(second.added).toBe(2);   // revised body + appendix
    expect(second.removed).toBe(1); // the retired body id
    expect(add).toHaveBeenCalledTimes(2);
    expect(second.vectorCount).toBe(4);

    const graph = tryLoadHnswSidecar(root)!;
    const live = new Set(graph.ids());
    expect(live.has(before.get('chunk-body')!)).toBe(false); // no orphan
    expect(live.has(after.get('chunk-body')!)).toBe(true);
    expect(live.has(after.get('chunk-appendix')!)).toBe(true);
    expect(live.has(after.get('chunk-intro')!)).toBe(true);
    expect(live.has(after.get('chunk-outro')!)).toBe(true);

    // The appended section is retrievable — it is genuinely in the graph, not
    // merely counted.
    const hits = graph.search(new Float32Array(vectorFor('a freshly appended section'.length)), 1);
    expect(hits[0].id).toBe(after.get('chunk-appendix'));

    // ── Session 3: nothing changed — no work, no write ───────────────────
    const serialize = vi.spyOn(HnswLite.prototype, 'serialize');
    const third = await syncHnswSidecar(dbPath, root, { dimensions: DIM });
    expect(third.mode).toBe('unchanged');
    expect(serialize).not.toHaveBeenCalled();
  });

  it('evicts every chunk of a doc that stopped being indexed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moflo-1384-chain-'));
    roots.push(root);
    mkdirSync(join(root, MOFLO_DIR));
    const dbPath = join(root, MOFLO_DIR, MEMORY_DB_FILE);
    await createSchema(dbPath);

    await reindex(dbPath, [
      { key: 'doc-a:1', content: 'alpha' },
      { key: 'doc-b:1', content: 'beta chunk' },
    ]);
    await embedMissing(dbPath);
    await syncHnswSidecar(dbPath, root, { dimensions: DIM });

    // doc-b is deleted from the repo — the indexer stops producing its chunks.
    await reindex(dbPath, [{ key: 'doc-a:1', content: 'alpha' }]);

    const result = await syncHnswSidecar(dbPath, root, { dimensions: DIM });
    expect(result.mode).toBe('incremental');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.vectorCount).toBe(1);
  });
});
