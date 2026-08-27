/**
 * The local HNSW path stops silently dropping results (#1468).
 *
 * Three defects compounded into non-deterministic recall, and all three lived on
 * the path taken when the AgentDB bridge is unavailable:
 *
 *   1. `getHNSWIndex` loaded the metadata map — the map `searchHNSWIndex`
 *      resolves every hit through — under a bare `LIMIT 10000` with no
 *      `ORDER BY`, so which rows survived was b-tree order. The sidecar is built
 *      with no LIMIT at all, so a store past the cap paired a complete graph
 *      with a truncated map and `searchHNSWIndex` skipped what it could not
 *      resolve.
 *   2. `searchEntries` returned early on `hnswResults.length > 0`, so ONE
 *      in-index hit suppressed the complete brute-force scan while ZERO hits
 *      produced correct and complete results.
 *   3. `deleteEntry` maintained no index at all, so a deleted entry's metadata
 *      outlived its row in an in-process map and kept being returned.
 *
 * The pins below are written so the pre-fix code fails each one: the cap is
 * driven down via `MOFLO_SEARCH_CANDIDATE_CAP` (a literal `10000` keeps every
 * seeded row and the size assertions go red), the fall-through is exercised with
 * an ANN that returns exactly one hit, and the delete case asserts absence from
 * the live map rather than from SQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAndWriteHnswSidecar } from '../../memory/hnsw-persistence.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { MOFLO_DIR, MEMORY_DB_FILE } from '../../services/moflo-paths.js';

const DIM = 8;

/** Distinct, deterministic unit-ish vectors — enough for the graph to be built. */
function vectorFor(seed: number): number[] {
  return Array.from({ length: DIM }, (_, j) => Number(Math.sin(seed * 0.7 + j * 0.3).toFixed(6)));
}

/** A project root laid out the way `getHNSWIndex` expects: <root>/.moflo/memory.db. */
function makeProject(): { root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1468-'));
  const dir = path.join(root, MOFLO_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dbPath: path.join(dir, MEMORY_DB_FILE) };
}

/**
 * Seed `count` active embedded rows. `created_at` ascends with the index, so
 * row N-1 is the newest — which is what the recency assertions key on.
 */
function seed(dbPath: string, count: number, namespace = 'learnings'): void {
  const db = openDaemonDatabase(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT,
      namespace TEXT,
      content TEXT,
      metadata TEXT,
      embedding TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      status TEXT
    )`);
    for (let i = 0; i < count; i++) {
      db.run(
        `INSERT INTO memory_entries
           (id, key, namespace, content, metadata, embedding, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'active')`,
        [
          `row-${String(i).padStart(3, '0')}`,
          `key-${i}`,
          namespace,
          `content ${i}`,
          JSON.stringify(vectorFor(i)),
          1_700_000_000_000 + i * 1000,
          1_700_000_000_000 + i * 1000,
        ],
      );
    }
  } finally {
    db.close();
  }
}

const ORIGINAL_CAP = process.env.MOFLO_SEARCH_CANDIDATE_CAP;
const ORIGINAL_ROUTING = process.env.MOFLO_DISABLE_DAEMON_ROUTING;
const roots: string[] = [];

beforeEach(() => {
  process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
});

afterEach(async () => {
  bridgeStub = null;
  if (ORIGINAL_CAP === undefined) delete process.env.MOFLO_SEARCH_CANDIDATE_CAP;
  else process.env.MOFLO_SEARCH_CANDIDATE_CAP = ORIGINAL_CAP;
  if (ORIGINAL_ROUTING === undefined) delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
  else process.env.MOFLO_DISABLE_DAEMON_ROUTING = ORIGINAL_ROUTING;

  const { clearHNSWIndex } = await import('../../memory/hnsw-singleton.js');
  clearHNSWIndex();

  while (roots.length) {
    try {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      // Windows can hold a handle briefly; the tempdir is disposable either way.
    }
  }
  vi.restoreAllMocks();
});

// The bridge short-circuits `searchHNSWIndex`, `searchEntries` and `deleteEntry`
// before any of this code runs. It is absent in CI, but pinning it keeps a
// developer machine with one installed from silently skipping every assertion.
//
// One hoisted mock reading a mutable stub, rather than a per-test `doMock`: a
// `doMock` of this path survives into later tests in the same file, and the
// tests that follow then hit a bridge that answers deletes but not searches.
let bridgeStub: unknown = null;
vi.mock('../../memory/bridge-loader.js', () => ({
  getBridge: async () => bridgeStub,
  isBridgeLoaded: () => bridgeStub !== null,
}));

describe('HNSW metadata load is capped by policy, not by a literal (#1468)', () => {
  it('keeps the NEWEST rows when the cap truncates, not whichever the b-tree reached', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 6);

    process.env.MOFLO_SEARCH_CANDIDATE_CAP = '3';
    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();

    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(index).not.toBeNull();

    // The old loader had no ORDER BY and a literal 10000 — it kept all six, in
    // insertion order. Both halves of this assertion were false before the fix.
    expect(index!.entries.size).toBe(3);
    expect([...index!.entries.values()].map(e => e.key).sort()).toEqual(['key-3', 'key-4', 'key-5']);
  });

  it('leaves no graph vector without a metadata row on the sidecar path', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 6);

    // The sidecar is built over every embedded row — no LIMIT. This is the only
    // configuration in which the graph and the map could ever disagree.
    const built = await buildAndWriteHnswSidecar(dbPath, root, { dimensions: DIM });
    expect(built.vectorCount).toBe(6);

    process.env.MOFLO_SEARCH_CANDIDATE_CAP = '3';
    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();

    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(index).not.toBeNull();

    // Pre-fix this was 6 vectors against a 10,000-row map that held all 6 — and
    // at a realistic store size, 13,825 vectors against 10,000 rows, where the
    // 3,825 remainder consumed ANN slots for hits that could never be returned.
    expect(await index!.db.len()).toBe(index!.entries.size);
    expect(await index!.db.len()).toBe(3);
  });

  it('caps graph and map together when no sidecar exists', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 6);

    process.env.MOFLO_SEARCH_CANDIDATE_CAP = '4';
    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();

    // This path inserts each vector alongside its metadata row, so it was never
    // capable of orphaning one. Pinned so the prune added for the sidecar path
    // cannot quietly start removing vectors here.
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(await index!.db.len()).toBe(4);
    expect(index!.entries.size).toBe(4);
  });

  it('does not empty the graph when the metadata load returns nothing', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 4);
    await buildAndWriteHnswSidecar(dbPath, root, { dimensions: DIM });

    // Archive every row: the loader's `status = 'active'` filter now matches
    // none. An empty result is far more likely a read that went wrong than a
    // store whose rows all vanished, so the prune declines to act on it —
    // emptying the graph would be unrecoverable until the next rebuild.
    const db = openDaemonDatabase(dbPath);
    db.run(`UPDATE memory_entries SET status = 'archived'`);
    db.close();

    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();

    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(index!.entries.size).toBe(0);
    expect(await index!.db.len()).toBe(4);
  });
});

describe('removeFromHNSWIndex keeps the in-process index in step (#1468)', () => {
  it('is a no-op when this process holds no index', async () => {
    const { clearHNSWIndex, removeFromHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();

    // Must not throw, and must not force a load just to delete from it.
    expect(removeFromHNSWIndex('learnings', 'key-0')).toBe(0);
  });

  it('drops the metadata row AND the graph vector', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 5);

    const { clearHNSWIndex, getHNSWIndex, removeFromHNSWIndex } =
      await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(index!.entries.size).toBe(5);

    expect(removeFromHNSWIndex('learnings', 'key-2')).toBe(1);

    expect([...index!.entries.values()].map(e => e.key)).not.toContain('key-2');
    expect(index!.entries.size).toBe(4);
    expect(await index!.db.len()).toBe(4);
  });

  it('only removes the entry in the named namespace', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 2, 'learnings');

    const db = openDaemonDatabase(dbPath);
    db.run(
      `INSERT INTO memory_entries
         (id, key, namespace, content, metadata, embedding, created_at, updated_at, status)
       VALUES ('other', 'key-0', 'patterns', 'c', NULL, ?, ?, ?, 'active')`,
      [JSON.stringify(vectorFor(9)), 1_700_000_000_000, 1_700_000_000_000],
    );
    db.close();

    const { clearHNSWIndex, getHNSWIndex, removeFromHNSWIndex } =
      await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });

    // `key-0` exists in both namespaces; deleting one must not take the other.
    expect(removeFromHNSWIndex('learnings', 'key-0')).toBe(1);
    expect(index!.entries.get('other')?.namespace).toBe('patterns');
  });

  it('deleteEntry removes the entry when the bridge served the delete', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 3, 'patterns');

    // The bridge returns before the direct-write path ever runs, so its branch
    // needs its own coverage — a removal call added only to the direct path
    // would leave every bridge-backed consumer exactly as broken as before.
    // Reset first so `entries-write` and `hnsw-singleton` share one fresh module
    // registry, and the singleton this test inspects is the one it mutates.
    vi.resetModules();
    bridgeStub = {
      bridgeDeleteEntry: async (opts: { key: string; namespace?: string }) => ({
        success: true,
        deleted: true,
        key: opts.key,
        namespace: opts.namespace ?? 'default',
        remainingEntries: 0,
      }),
    };

    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(index!.entries.size).toBe(3);

    const { deleteEntry } = await import('../../memory/entries-write.js');
    expect((await deleteEntry({ key: 'key-2', namespace: 'patterns', dbPath })).deleted).toBe(true);

    expect([...index!.entries.values()].map(e => e.key)).not.toContain('key-2');
    expect(await index!.db.len()).toBe(2);
  });

  it('leaves the index alone when the bridge reports nothing was deleted', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 3, 'patterns');

    vi.resetModules();
    bridgeStub = {
      bridgeDeleteEntry: async (opts: { key: string; namespace?: string }) => ({
        success: true,
        deleted: false,
        key: opts.key,
        namespace: opts.namespace ?? 'default',
        remainingEntries: 3,
      }),
    };

    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });

    const { deleteEntry } = await import('../../memory/entries-write.js');
    expect((await deleteEntry({ key: 'key-2', namespace: 'patterns', dbPath })).deleted).toBe(false);

    // `deleted: false` means the row was already gone, not that this one should
    // leave the index — the entry is still live and must stay searchable.
    expect(index!.entries.size).toBe(3);
    expect(await index!.db.len()).toBe(3);
  });

  it('deleteEntry removes the entry from a loaded index', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 3, 'patterns');

    const { clearHNSWIndex, getHNSWIndex } = await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(index!.entries.size).toBe(3);

    const { deleteEntry } = await import('../../memory/entries-write.js');
    const result = await deleteEntry({ key: 'key-1', namespace: 'patterns', dbPath });
    expect(result.deleted).toBe(true);

    // The row is gone from SQL either way — what regressed was the in-process
    // map, which kept serving the deleted entry until the process restarted.
    expect([...index!.entries.values()].map(e => e.key)).not.toContain('key-1');
    expect(await index!.db.len()).toBe(2);
  });
});

describe('searchHNSWIndex widens when the namespace filter starves it (#1468)', () => {
  /** `[1, 0…]` for the query and the crowd; `[0…, 1]` for the sparse namespace. */
  function axis(last: boolean): number[] {
    const v = new Array(DIM).fill(0);
    v[last ? DIM - 1 : 0] = 1;
    return v;
  }

  it('returns a sparse namespace the global top-k would have crowded out', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);

    const db = openDaemonDatabase(dbPath);
    db.run(`CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY, key TEXT, namespace TEXT, content TEXT,
      metadata TEXT, embedding TEXT, created_at INTEGER, updated_at INTEGER, status TEXT
    )`);
    // 27 rows sitting on the query's own axis, 3 orthogonal to it. The graph is
    // shared, so a `k * 2` retrieval is filled entirely by the crowd and the
    // namespace filter then throws all of it away.
    for (let i = 0; i < 30; i++) {
      const sparse = i >= 27;
      db.run(
        `INSERT INTO memory_entries
           (id, key, namespace, content, metadata, embedding, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'active')`,
        [
          `row-${String(i).padStart(3, '0')}`,
          `key-${i}`,
          sparse ? 'learnings' : 'patterns',
          `content ${i}`,
          JSON.stringify(axis(sparse)),
          1_700_000_000_000 + i * 1000,
          1_700_000_000_000 + i * 1000,
        ],
      );
    }
    db.close();

    const { clearHNSWIndex, getHNSWIndex, searchHNSWIndex } =
      await import('../../memory/hnsw-singleton.js');
    clearHNSWIndex();
    const index = await getHNSWIndex({ dbPath, dimensions: DIM });
    expect(await index!.db.len()).toBe(30);

    const hits = await searchHNSWIndex(axis(false), { k: 5, namespace: 'learnings' });

    // Pre-fix this came back empty, and `searchEntries` read that as "the index
    // cannot serve this" — sending every query on that namespace to a SQL scan.
    expect(hits!.map(h => h.key).sort()).toEqual(['key-27', 'key-28', 'key-29']);
  });
});

describe('searchEntries falls through and merges instead of short-circuiting (#1468)', () => {
  /** Load `searchEntries` with `searchHNSWIndex` stubbed to `hits`. */
  async function searchWithAnn(
    hits: Array<{ id: string; key: string; content: string; score: number; namespace: string }>,
    dbPath: string,
    limit = 5,
  ) {
    vi.resetModules();
    bridgeStub = null;
    vi.doMock('../../memory/hnsw-singleton.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/hnsw-singleton.js')>(
        '../../memory/hnsw-singleton.js',
      );
      return { ...actual, searchHNSWIndex: vi.fn(async () => hits) };
    });
    vi.doMock('../../memory/embedding-model.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/embedding-model.js')>(
        '../../memory/embedding-model.js',
      );
      return { ...actual, generateEmbedding: vi.fn(async () => ({ embedding: vectorFor(0) })) };
    });
    const { searchEntries } = await import('../../memory/entries-read.js');
    return searchEntries({ query: 'q', namespace: 'learnings', limit, threshold: -1, dbPath });
  }

  it('a single ANN hit yields the same complete set as no ANN hit at all', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 5);

    const one = await searchWithAnn(
      [{ id: 'row-000', key: 'key-0', content: 'content 0', score: 0.9, namespace: 'learnings' }],
      dbPath,
    );
    const none = await searchWithAnn([], dbPath);

    // This is the whole defect: pre-fix, `one` returned a single result and
    // `none` returned all five, with no way for the caller to tell which it got.
    expect(one.results.map(r => r.key).sort()).toEqual(none.results.map(r => r.key).sort());
    expect(one.results).toHaveLength(5);
  });

  it('does not double-count an id both paths returned', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 5);

    const merged = await searchWithAnn(
      [{ id: 'row-000', key: 'key-0', content: 'content 0', score: 0.99, namespace: 'learnings' }],
      dbPath,
    );

    const ids = merged.results.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the higher score when the two paths disagree', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 5);

    // The query embedding is `vectorFor(0)`, so the scan scores `row-001` well
    // below 1 — leaving room for a higher ANN score on the same id to win.
    const scanOnly = await searchWithAnn([], dbPath);
    const scanScore = scanOnly.results.find(r => r.id === 'row-001')!.score;
    expect(scanScore).toBeLessThan(1);

    const merged = await searchWithAnn(
      [{ id: 'row-001', key: 'key-1', content: 'content 1', score: 1, namespace: 'learnings' }],
      dbPath,
    );

    expect(merged.results.find(r => r.id === 'row-001')?.score).toBe(1);
  });

  it('contributes an ANN hit the capped scan never saw', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 5);

    // Cap the scan below the store size so the oldest row falls outside it, then
    // hand that row back through the ANN. Discarding the ANN results on
    // fall-through would trade the old non-determinism for a different gap.
    process.env.MOFLO_SEARCH_CANDIDATE_CAP = '2';
    const merged = await searchWithAnn(
      [{ id: 'row-000', key: 'key-0', content: 'content 0', score: 0.7, namespace: 'learnings' }],
      dbPath,
    );

    expect(merged.results.map(r => r.key)).toContain('key-0');
  });

  it('still short-circuits when the ANN filled the request', async () => {
    const { root, dbPath } = makeProject();
    roots.push(root);
    seed(dbPath, 5);

    const hits = [0, 1].map(i => ({
      id: `ann-${i}`,
      key: `ann-key-${i}`,
      content: 'x',
      score: 0.8,
      namespace: 'learnings',
    }));
    const result = await searchWithAnn(hits, dbPath, 2);

    // The fast path must survive the fix — a fall-through on every query would
    // make the index pointless.
    expect(result.results.map(r => r.key)).toEqual(['ann-key-0', 'ann-key-1']);
  });
});
