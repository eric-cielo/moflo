/**
 * Integration test — SqlJsMemoryEntriesStore against the real `MEMORY_SCHEMA_V3`
 *
 * Issue #547: the previous store adapter queried `value` and wrote
 * `dimensions` / `Buffer` BLOB, but v3 schema uses `content`,
 * `embedding_dimensions`, and JSON TEXT. The probe guard in
 * `embeddings-migration.ts` passed because the `embedding` column does exist,
 * so migrations ran and threw at runtime. This test runs the full driver
 * against a DB built from the exact schema constant that production uses,
 * so schema drift is caught at test time.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import {
  EMBEDDINGS_VERSION,
  migrateStore,
} from '../../embeddings/migration/index.js';
import { CANONICAL_EMBEDDING_MODEL } from '../../embeddings/migration/types.js';
import { MockBatchEmbedder } from '../../embeddings/__tests__/migration/mock-batch-embedder.js';
import { SqlJsMemoryEntriesStore } from '../../services/sqljs-migration-store.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';

// ── sql.js bootstrap ────────────────────────────────────────────────────────
type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlJsDb;
};
type SqlJsDb = {
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    free(): void;
    run(params?: unknown[]): void;
  };
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
};

let SQL: SqlJsStatic;

beforeAll(async () => {
  const initSqlJs = (await import('sql.js')).default;
  SQL = (await initSqlJs()) as SqlJsStatic;
});

function freshV3Db(): SqlJsDb {
  const db = new SQL.Database();
  // Apply the real production schema. If this DDL ever changes in a way that
  // breaks the migration store, this test fails loud.
  db.run(MEMORY_SCHEMA_V3);
  return db;
}

function insertEntry(db: SqlJsDb, id: string, content: string): void {
  db.run(
    `INSERT INTO memory_entries (id, key, content) VALUES (?, ?, ?)`,
    [id, `k-${id}`, content],
  );
}

function selectEmbeddingRow(
  db: SqlJsDb,
  id: string,
): { embedding: string | null; dims: number | null } {
  const res = db.exec(
    `SELECT embedding, embedding_dimensions FROM memory_entries WHERE id = '${id.replace(/'/g, "''")}'`,
  );
  const row = res[0]?.values[0];
  if (!row) return { embedding: null, dims: null };
  return {
    embedding: row[0] === null ? null : String(row[0]),
    dims: row[1] === null ? null : Number(row[1]),
  };
}

describe('SqlJsMemoryEntriesStore against MEMORY_SCHEMA_V3', () => {
  it('counts rows using the v3 `content` column, not the defunct `value`', async () => {
    const db = freshV3Db();
    insertEntry(db, 'a', 'hello world');
    insertEntry(db, 'b', 'goodbye');
    // An empty content row must not be counted — matches iteration behaviour.
    db.run(
      `INSERT INTO memory_entries (id, key, content) VALUES ('empty', 'k-empty', '')`,
    );

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');
    expect(await store.countItems()).toBe(2);
    db.close();
  });

  it('iterItems pulls sourceText from the v3 `content` column', async () => {
    const db = freshV3Db();
    insertEntry(db, 'a', 'alpha');
    insertEntry(db, 'b', 'beta');

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');
    const rows = await store.iterItems(null, 10);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.sourceText)).toEqual(['alpha', 'beta']);
    db.close();
  });

  it('updateBatch writes JSON embeddings and embedding_dimensions', async () => {
    const db = freshV3Db();
    insertEntry(db, 'a', 'hello');
    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');

    const emb = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    await store.updateBatch([{ id: 'a', embedding: emb }]);

    const { embedding, dims } = selectEmbeddingRow(db, 'a');
    expect(dims).toBe(4);
    // Must be JSON text (parseable as number[]) — the production `embeddings
    // search` path does JSON.parse on this column, so BLOB would crash it.
    expect(typeof embedding).toBe('string');
    const parsed = JSON.parse(embedding!);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toBeCloseTo(0.1, 6);
    expect(parsed[3]).toBeCloseTo(0.4, 6);
    db.close();
  });

  it('end-to-end: migrateStore re-embeds every row in a v3 DB', async () => {
    const db = freshV3Db();
    for (let i = 0; i < 5; i++) {
      insertEntry(db, `id-${i}`, `item-${i}`);
    }

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');
    const embedder = new MockBatchEmbedder(8);

    const result = await migrateStore({ store, embedder, batchSize: 2 });

    expect(result.success).toBe(true);
    expect(result.itemsMigrated).toBe(5);
    expect(result.versionBumped).toBe(true);
    expect(await store.getVersion()).toBe(EMBEDDINGS_VERSION);

    // Every row has a JSON embedding of the expected dimension.
    for (let i = 0; i < 5; i++) {
      const { embedding, dims } = selectEmbeddingRow(db, `id-${i}`);
      expect(dims).toBe(8);
      const parsed = JSON.parse(embedding!) as number[];
      expect(parsed).toHaveLength(8);
    }
    db.close();
  });

  it('cursor round-trips through migration_cursor (resume-safety)', async () => {
    const db = freshV3Db();
    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');

    expect(await store.loadCursor()).toBeNull();

    await store.saveCursor({
      storeId: store.storeId,
      lastProcessedId: 'id-0042',
      itemsDone: 42,
      itemsTotal: 100,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
    });

    const loaded = await store.loadCursor();
    expect(loaded?.itemsDone).toBe(42);
    expect(loaded?.lastProcessedId).toBe('id-0042');

    await store.clearCursor();
    expect(await store.loadCursor()).toBeNull();
    db.close();
  });

  it('setVersion/getVersion round-trip via shared metadata table', async () => {
    const db = freshV3Db();
    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');

    expect(await store.getVersion()).toBeNull();
    await store.setVersion(7);
    expect(await store.getVersion()).toBe(7);
    // Upserts, never duplicates.
    await store.setVersion(9);
    expect(await store.getVersion()).toBe(9);
    db.close();
  });
});

describe('SqlJsMemoryEntriesStore — eligibility-aware repair (#650)', () => {
  // Use the canonical constant so a rename in embeddings/migration/types.ts
  // ripples through every test reference automatically. The store's contract
  // is "tag rows with whatever the orchestrator passes" — testing identity is
  // fine here; testing the producer-consumer chain happens in the e2e test
  // below where MockBatchEmbedder rewrites everything.
  const TARGET_MODEL = CANONICAL_EMBEDDING_MODEL;

  function insertWithModel(
    db: SqlJsDb,
    id: string,
    content: string,
    model: string | null,
  ): void {
    if (model === null) {
      db.run(
        `INSERT INTO memory_entries (id, key, content) VALUES (?, ?, ?)`,
        [id, `k-${id}`, content],
      );
    } else {
      db.run(
        `INSERT INTO memory_entries (id, key, content, embedding_model)
         VALUES (?, ?, ?, ?)`,
        [id, `k-${id}`, content, model],
      );
    }
  }

  function selectModelRow(
    db: SqlJsDb,
    id: string,
  ): { model: string | null; dims: number | null } {
    const res = db.exec(
      `SELECT embedding_model, embedding_dimensions FROM memory_entries WHERE id = '${id.replace(/'/g, "''")}'`,
    );
    const row = res[0]?.values[0];
    if (!row) return { model: null, dims: null };
    return {
      model: row[0] === null ? null : String(row[0]),
      dims: row[1] === null ? null : Number(row[1]),
    };
  }

  it('countItems excludes rows already on the target model', async () => {
    const db = freshV3Db();
    insertWithModel(db, 'on-target-1', 'a', TARGET_MODEL);
    insertWithModel(db, 'on-target-2', 'b', TARGET_MODEL);
    insertWithModel(db, 'xenova', 'c', 'Xenova/all-MiniLM-L6-v2');
    insertWithModel(db, 'hash', 'd', 'domain-aware-hash-v1');
    insertWithModel(db, 'null-model', 'e', null); // schema default 'local'

    const repair = new SqlJsMemoryEntriesStore(db, 'memory.db', {
      targetModel: TARGET_MODEL,
    });
    // 3 ineligible: xenova + hash + null-model. The two on-target rows are
    // filtered out — short-circuit candidates for the orchestrator.
    expect(await repair.countItems()).toBe(3);

    // Without targetModel the legacy "every content row" semantics still apply.
    const legacy = new SqlJsMemoryEntriesStore(db, 'memory.db');
    expect(await legacy.countItems()).toBe(5);
    db.close();
  });

  it('hasIneligibleRows is the bounded probe used by the session-start short-circuit', async () => {
    const db = freshV3Db();
    insertWithModel(db, 'on', 'a', TARGET_MODEL);
    const store = new SqlJsMemoryEntriesStore(db, 'memory.db', { targetModel: TARGET_MODEL });

    expect(await store.hasIneligibleRows()).toBe(false);

    // Add one row tagged with a banned legacy model — probe trips immediately.
    insertWithModel(db, 'off', 'b', 'domain-aware-hash-v1');
    expect(await store.hasIneligibleRows()).toBe(true);

    // Stores constructed without targetModel never report ineligible rows —
    // the contract is that legacy callers don't get the new repair behavior.
    const legacy = new SqlJsMemoryEntriesStore(db, 'memory.db');
    expect(await legacy.hasIneligibleRows()).toBe(false);
    db.close();
  });

  it('iterItems yields only ineligible rows when targetModel is set', async () => {
    const db = freshV3Db();
    insertWithModel(db, 'a-on', 'a', TARGET_MODEL);
    insertWithModel(db, 'b-off', 'b', 'Xenova/all-MiniLM-L6-v2');
    insertWithModel(db, 'c-on', 'c', TARGET_MODEL);
    insertWithModel(db, 'd-off', 'd', null);

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db', {
      targetModel: TARGET_MODEL,
    });
    const rows = await store.iterItems(null, 100);
    expect(rows.map((r) => r.id)).toEqual(['b-off', 'd-off']);

    // Cursor pagination still works against the filtered set.
    const tail = await store.iterItems('b-off', 100);
    expect(tail.map((r) => r.id)).toEqual(['d-off']);
    db.close();
  });

  it('updateBatch re-tags embedding_model when targetModel is set', async () => {
    const db = freshV3Db();
    insertWithModel(db, 'x', 'content', 'Xenova/all-MiniLM-L6-v2');

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db', {
      targetModel: TARGET_MODEL,
    });
    await store.updateBatch([{ id: 'x', embedding: new Float32Array(8).fill(0.5) }]);

    const { model, dims } = selectModelRow(db, 'x');
    expect(model).toBe(TARGET_MODEL);
    expect(dims).toBe(8);
    db.close();
  });

  it('updateBatch leaves embedding_model untouched when targetModel is unset (legacy)', async () => {
    const db = freshV3Db();
    insertWithModel(db, 'x', 'content', 'Xenova/all-MiniLM-L6-v2');

    const legacy = new SqlJsMemoryEntriesStore(db, 'memory.db');
    await legacy.updateBatch([{ id: 'x', embedding: new Float32Array(8).fill(0.5) }]);

    // Backward-compat: legacy store does not re-tag — model column is preserved.
    const { model, dims } = selectModelRow(db, 'x');
    expect(model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(dims).toBe(8);
    db.close();
  });

  it('end-to-end repair: mixed-model DB converges to all rows on target', async () => {
    const db = freshV3Db();
    insertWithModel(db, 'on', 'on-target', TARGET_MODEL);
    insertWithModel(db, 'xenova', 'xen', 'Xenova/all-MiniLM-L6-v2');
    insertWithModel(db, 'hash', 'h', 'domain-aware-hash-v1');
    insertWithModel(db, 'null-model', 'n', null);

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db', {
      targetModel: TARGET_MODEL,
    });
    const embedder = new MockBatchEmbedder(8);

    const result = await migrateStore({ store, embedder, batchSize: 2 });
    expect(result.success).toBe(true);
    expect(result.itemsMigrated).toBe(3); // only the three ineligibles

    // Post-condition: every row is on the target model.
    const res = db.exec(
      `SELECT embedding_model, COUNT(*) AS n FROM memory_entries GROUP BY embedding_model`,
    );
    const grouped = (res[0]?.values ?? []).map((r) => ({
      model: String(r[0]),
      count: Number(r[1]),
    }));
    expect(grouped).toEqual([{ model: TARGET_MODEL, count: 4 }]);

    // Eligibility filter has zero work left — the next call short-circuits.
    expect(await store.countItems()).toBe(0);
    db.close();
  });
});
