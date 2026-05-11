/**
 * SqliteBackend parity tests — epic #1078 Phase 1 (#1080).
 *
 * Two responsibilities:
 *
 * 1. **Backend correctness** — every IMemoryBackend method behaves as the
 *    drop-in spec demands (mirrors SqlJsBackend behavior shape-for-shape).
 *
 * 2. **Sql.js parity** — for every operation that has an equivalent on
 *    SqlJsBackend, the row-level outcome is identical. Patterns lifted from
 *    `scripts/spike-node-sqlite.mjs` (the Phase 0 spike) per the issue
 *    comment's "lift assertions from spike" guidance.
 *
 * WAL sidecar assertion is gated to disk paths only; `:memory:` doesn't emit
 * `.db-wal` / `.db-shm`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SqliteBackend } from './sqlite-backend.js';
import { SqlJsBackend } from './sqljs-backend.js';
import { createDefaultEntry, MemoryEntry } from './types.js';
import { createDatabase, getAvailableProviders } from './database-provider.js';

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const base = createDefaultEntry({
    key: `k-${randomUUID()}`,
    content: 'hello',
    namespace: 'test-ns',
  });
  return { ...base, ...overrides };
}

describe('SqliteBackend', () => {
  let workDir: string;
  let dbPath: string;
  let backend: SqliteBackend;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'moflo-sqlite-backend-'));
    dbPath = join(workDir, 'test.db');
    backend = new SqliteBackend({ databasePath: dbPath });
    await backend.initialize();
  });

  afterEach(async () => {
    try { await backend.shutdown(); } catch { /* idempotent */ }
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('initialization + WAL', () => {
    it('creates the schema and is ready to accept writes', async () => {
      await expect(backend.count()).resolves.toBe(0);
    });

    it('opens disk-backed databases in WAL mode (sidecars appear on first write)', async () => {
      await backend.store(makeEntry());
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
    });

    it('initialize() is idempotent', async () => {
      await backend.initialize();
      await backend.initialize();
      await expect(backend.count()).resolves.toBe(0);
    });
  });

  describe('CRUD round-trip', () => {
    it('stores and retrieves by id', async () => {
      const e = makeEntry({ key: 'rt-key', content: 'rt-content' });
      await backend.store(e);
      const got = await backend.get(e.id);
      expect(got?.key).toBe('rt-key');
      expect(got?.content).toBe('rt-content');
    });

    it('stores and retrieves by namespace+key', async () => {
      const e = makeEntry({ namespace: 'ns-a', key: 'k-1', content: 'v-1' });
      await backend.store(e);
      const got = await backend.getByKey('ns-a', 'k-1');
      expect(got?.content).toBe('v-1');
    });

    it('returns null for unknown id / key', async () => {
      await expect(backend.get('does-not-exist')).resolves.toBeNull();
      await expect(backend.getByKey('nope', 'nope')).resolves.toBeNull();
    });

    it('update() bumps version and merges fields', async () => {
      const e = makeEntry({ content: 'v1' });
      await backend.store(e);
      const updated = await backend.update(e.id, { content: 'v2' });
      expect(updated?.content).toBe('v2');
      expect(updated?.version).toBe(e.version + 1);
    });

    it('delete() removes by id', async () => {
      const e = makeEntry();
      await backend.store(e);
      await expect(backend.delete(e.id)).resolves.toBe(true);
      await expect(backend.get(e.id)).resolves.toBeNull();
    });

    it('INSERT OR REPLACE semantics — same id overwrites content', async () => {
      const e = makeEntry({ key: 'or-replace', content: 'first' });
      await backend.store(e);
      await backend.store({ ...e, content: 'second' });
      const row = await backend.get(e.id);
      expect(row?.content).toBe('second');
      await expect(backend.count()).resolves.toBe(1);
    });
  });

  describe('embeddings round-trip', () => {
    it('preserves Float32Array values byte-for-byte through BLOB storage', async () => {
      const vec = new Float32Array([0.1, 0.2, -0.3, Math.PI, 0, -Infinity, Infinity, NaN]);
      const e = makeEntry({ embedding: vec });
      await backend.store(e);
      const got = await backend.get(e.id);
      expect(got?.embedding).toBeInstanceOf(Float32Array);
      expect(got?.embedding?.length).toBe(vec.length);
      for (let i = 0; i < vec.length; i++) {
        if (Number.isNaN(vec[i])) {
          expect(Number.isNaN(got!.embedding![i])).toBe(true);
        } else {
          expect(got!.embedding![i]).toBe(vec[i]);
        }
      }
    });
  });

  describe('query + filters', () => {
    beforeEach(async () => {
      const now = Date.now();
      await backend.bulkInsert([
        makeEntry({ namespace: 'ns-a', key: 'a1', type: 'semantic', createdAt: now - 3000 }),
        makeEntry({ namespace: 'ns-a', key: 'a2', type: 'episodic', createdAt: now - 2000 }),
        makeEntry({ namespace: 'ns-b', key: 'b1', type: 'semantic', createdAt: now - 1000 }),
      ]);
    });

    it('filters by namespace', async () => {
      const rows = await backend.query({ type: 'hybrid', namespace: 'ns-a', limit: 10 });
      expect(rows).toHaveLength(2);
    });

    it('filters by memoryType', async () => {
      const rows = await backend.query({ type: 'hybrid', memoryType: 'semantic', limit: 10 });
      expect(rows).toHaveLength(2);
    });

    it('orders by created_at DESC', async () => {
      const rows = await backend.query({ type: 'hybrid', limit: 10 });
      const keys = rows.map((r) => r.key);
      expect(keys).toEqual(['b1', 'a2', 'a1']);
    });

    it('honors limit and offset', async () => {
      const first = await backend.query({ type: 'hybrid', limit: 1 });
      const second = await backend.query({ type: 'hybrid', limit: 1, offset: 1 });
      expect(first[0].key).toBe('b1');
      expect(second[0].key).toBe('a2');
    });
  });

  describe('namespace + bulk ops', () => {
    it('listNamespaces + count(namespace) + clearNamespace', async () => {
      await backend.bulkInsert([
        makeEntry({ namespace: 'x', key: 'k1' }),
        makeEntry({ namespace: 'x', key: 'k2' }),
        makeEntry({ namespace: 'y', key: 'k3' }),
      ]);
      const names = await backend.listNamespaces();
      expect(names.sort()).toEqual(['x', 'y']);
      await expect(backend.count('x')).resolves.toBe(2);
      await expect(backend.clearNamespace('x')).resolves.toBe(2);
      await expect(backend.count('x')).resolves.toBe(0);
      await expect(backend.count('y')).resolves.toBe(1);
    });

    it('bulkDelete returns the number of dispatched deletions (matches SqlJsBackend)', async () => {
      const e1 = makeEntry();
      const e2 = makeEntry();
      await backend.bulkInsert([e1, e2]);
      const removed = await backend.bulkDelete([e1.id, e2.id, 'no-such-id']);
      // Parity quirk shared with SqlJsBackend: delete() returns true even
      // when the row didn't exist, so bulkDelete counts attempted deletions
      // rather than actual ones. Lock the count to the exact value so a
      // future divergence trips the assertion.
      expect(removed).toBe(3);
      await expect(backend.count()).resolves.toBe(0);
    });
  });

  describe('search', () => {
    it('returns entries sorted by cosine similarity', async () => {
      const target = new Float32Array([1, 0, 0]);
      const close = makeEntry({ key: 'close', embedding: new Float32Array([0.99, 0.01, 0]), type: 'semantic' });
      const far = makeEntry({ key: 'far', embedding: new Float32Array([0, 1, 0]), type: 'semantic' });
      await backend.bulkInsert([close, far]);

      const results = await backend.search(target, { k: 2 });
      expect(results[0].entry.key).toBe('close');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });

  describe('healthCheck + stats', () => {
    it('reports healthy with all expected components', async () => {
      const h = await backend.healthCheck();
      expect(h.status).toBe('healthy');
      expect(h.components.storage.status).toBe('healthy');
      expect(h.components.index).toBeDefined();
      expect(h.components.cache).toBeDefined();
    });

    it('counts entries by type', async () => {
      await backend.bulkInsert([
        makeEntry({ type: 'semantic' }),
        makeEntry({ type: 'semantic' }),
        makeEntry({ type: 'episodic' }),
      ]);
      const stats = await backend.getStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.entriesByType.semantic).toBe(2);
      expect(stats.entriesByType.episodic).toBe(1);
    });
  });

  describe('persist()', () => {
    it('flushes data so a fresh handle on the same path reads it back', async () => {
      const stored = makeEntry({ key: 'persist-rt', content: 'on-disk' });
      await backend.store(stored);
      await backend.persist();
      await backend.shutdown();

      const reopened = new SqliteBackend({ databasePath: dbPath });
      await reopened.initialize();
      try {
        const got = await reopened.get(stored.id);
        expect(got?.content).toBe('on-disk');
      } finally {
        await reopened.shutdown();
      }
      // Reassign so afterEach's shutdown is a no-op.
      backend = new SqliteBackend({ databasePath: ':memory:' });
      await backend.initialize();
    });

    it('no-ops cleanly on :memory: backends', async () => {
      const memBackend = new SqliteBackend({ databasePath: ':memory:' });
      await memBackend.initialize();
      await expect(memBackend.persist()).resolves.toBeUndefined();
      await memBackend.shutdown();
    });
  });
});

// ─── Parity vs SqlJsBackend ──────────────────────────────────────────────
// Same write sequence on each engine; result row shapes must match.

describe('SqliteBackend ↔ SqlJsBackend parity', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'moflo-sqlite-parity-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('round-trips an entry with identical retrievable fields on both backends', async () => {
    const sqlJs = new SqlJsBackend({ databasePath: ':memory:', autoPersistInterval: 0 });
    const nodeSqlite = new SqliteBackend({ databasePath: ':memory:' });
    await sqlJs.initialize();
    await nodeSqlite.initialize();
    try {
      const entry = makeEntry({
        key: 'parity-key',
        content: 'parity content',
        namespace: 'parity-ns',
        tags: ['t1', 't2'],
        metadata: { source: 'spike-1079', dim: 3 },
        embedding: new Float32Array([0.5, -0.25, 0.125]),
      });
      await sqlJs.store(entry);
      await nodeSqlite.store(entry);

      const a = await sqlJs.get(entry.id);
      const b = await nodeSqlite.get(entry.id);

      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(b!.key).toBe(a!.key);
      expect(b!.content).toBe(a!.content);
      expect(b!.namespace).toBe(a!.namespace);
      expect(b!.tags).toEqual(a!.tags);
      expect(b!.metadata).toEqual(a!.metadata);
      expect(Array.from(b!.embedding!)).toEqual(Array.from(a!.embedding!));
    } finally {
      await sqlJs.shutdown();
      await nodeSqlite.shutdown();
    }
  });

  it('produces matching counts after the same write/delete sequence', async () => {
    const sqlJs = new SqlJsBackend({ databasePath: ':memory:', autoPersistInterval: 0 });
    const nodeSqlite = new SqliteBackend({ databasePath: ':memory:' });
    await sqlJs.initialize();
    await nodeSqlite.initialize();
    try {
      const entries = Array.from({ length: 20 }, () => makeEntry({ namespace: 'bulk' }));
      for (const e of entries) {
        await sqlJs.store(e);
        await nodeSqlite.store(e);
      }
      expect(await nodeSqlite.count()).toBe(await sqlJs.count());
      expect(await nodeSqlite.count('bulk')).toBe(await sqlJs.count('bulk'));

      const toDelete = entries.slice(0, 5).map((e) => e.id);
      for (const id of toDelete) {
        await sqlJs.delete(id);
        await nodeSqlite.delete(id);
      }
      expect(await nodeSqlite.count()).toBe(await sqlJs.count());
    } finally {
      await sqlJs.shutdown();
      await nodeSqlite.shutdown();
    }
  });
});

// ─── DatabaseProvider integration ─────────────────────────────────────────

describe('DatabaseProvider — node:sqlite is the default (#1083 Phase 4)', () => {
  let savedEnv: string | undefined;
  let workDir: string;

  beforeEach(() => {
    // MOFLO_DB_BACKEND is no longer respected (Phase 4 removed the escape
    // hatch). We still capture+restore so a parent process that exports the
    // variable can't leak into the test run.
    savedEnv = process.env.MOFLO_DB_BACKEND;
    delete process.env.MOFLO_DB_BACKEND;
    workDir = mkdtempSync(join(tmpdir(), 'moflo-dbprovider-nodesqlite-'));
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MOFLO_DB_BACKEND;
    else process.env.MOFLO_DB_BACKEND = savedEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('exposes nodeSqlite in getAvailableProviders()', async () => {
    const avail = await getAvailableProviders();
    expect(avail.nodeSqlite).toBe(true);
  });

  it('default selection picks SqliteBackend (node:sqlite) without any flag', async () => {
    const db = await createDatabase(join(workDir, 'default.db'));
    expect(db).toBeInstanceOf(SqliteBackend);
    const e = createDefaultEntry({ key: 'default-test', content: 'hi' });
    await db.store(e);
    const got = await db.get(e.id);
    expect(got?.key).toBe('default-test');
    await db.shutdown();
  });

  it('ignores MOFLO_DB_BACKEND=sql.js — env var is no longer the selection mechanism', async () => {
    process.env.MOFLO_DB_BACKEND = 'sql.js';
    const db = await createDatabase(join(workDir, 'ignored-env.db'));
    expect(db).toBeInstanceOf(SqliteBackend);
    await db.shutdown();
  });

  it('explicit provider: "node-sqlite" works', async () => {
    const db = await createDatabase(':memory:', { provider: 'node-sqlite' });
    expect(db).toBeInstanceOf(SqliteBackend);
    await db.shutdown();
  });

  it('explicit provider: "sql.js" still routes through SqlJsBackend (shadow-read uses it)', async () => {
    const db = await createDatabase(':memory:', { provider: 'sql.js' });
    expect(db).not.toBeInstanceOf(SqliteBackend);
    await db.shutdown();
  });
});
