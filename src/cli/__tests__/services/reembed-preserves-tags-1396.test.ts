/**
 * #1396 (Epic #1392) — the re-embed / re-index path must preserve every column
 * it does not own.
 *
 * The field report named the background re-embed as the prime suspect for the
 * dropped `tags` ("a re-persist path that reconstructs the row without carrying
 * tags forward would explain both symptoms"). It was not the culprit — the real
 * cause was the entry cache being warmed with a partial value, covered by
 * `bridge-entry-cache-shape-1396.test.ts`.
 *
 * The suspicion was still worth nailing down permanently, because the failure
 * mode it describes is real and has happened before: #1067 was exactly a
 * re-persist that used `INSERT OR REPLACE` with only the embedding columns and
 * silently reset metadata/tags/expires_at. This is the ticket's "regression
 * guard that matters" — a re-embed must replace the embedding and nothing else.
 */

import { describe, it, expect } from 'vitest';

import { migrateStore } from '../../embeddings/migration/index.js';
import { MockBatchEmbedder } from '../../embeddings/__tests__/migration/mock-batch-embedder.js';
import { SqlJsMemoryEntriesStore } from '../../services/sqljs-migration-store.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../../memory/daemon-backend.js';

function freshV3Db(): SqlJsLikeDatabase {
  const db = openDaemonDatabase(':memory:');
  db.run(MEMORY_SCHEMA_V3);
  return db;
}

function readRow(db: SqlJsLikeDatabase, id: string) {
  const res = db.exec(
    `SELECT tags, metadata, created_at, updated_at, access_count, embedding
     FROM memory_entries WHERE id = '${id.replace(/'/g, "''")}'`,
  );
  const row = res[0]?.values[0];
  if (!row) throw new Error(`row ${id} vanished`);
  return {
    tags: row[0] === null ? null : String(row[0]),
    metadata: row[1] === null ? null : String(row[1]),
    createdAt: Number(row[2]),
    updatedAt: row[3] === null ? null : Number(row[3]),
    accessCount: Number(row[4]),
    embedding: row[5] === null ? null : String(row[5]),
  };
}

describe('re-embed preserves non-embedding columns (#1396)', () => {
  it('keeps tags, metadata, created_at and access_count across a full re-embed', async () => {
    const db = freshV3Db();
    const createdAt = 1_700_000_000_000;
    db.run(
      `INSERT INTO memory_entries
         (id, key, namespace, content, tags, metadata, created_at, updated_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'r1', 'k-r1', 'learnings', 'a learning worth keeping',
        JSON.stringify(['testing', 'source:manual']),
        JSON.stringify({ type: 'note', overall: 'PASS' }),
        createdAt, createdAt, 7,
      ],
    );

    const before = readRow(db, 'r1');
    expect(before.embedding).toBeNull();

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');
    const result = await migrateStore({ store, embedder: new MockBatchEmbedder(8), batchSize: 10 });
    expect(result.success).toBe(true);
    expect(result.itemsMigrated).toBe(1);

    const after = readRow(db, 'r1');

    // The one thing a re-embed IS allowed to change.
    expect(after.embedding).not.toBeNull();
    expect(JSON.parse(after.embedding!)).toHaveLength(8);

    // Everything else must be byte-identical. A row-reconstructing re-persist
    // — the #1067 shape, and what the field report suspected here — fails these.
    expect(after.tags).toBe(before.tags);
    expect(JSON.parse(after.tags!)).toEqual(['testing', 'source:manual']);
    expect(after.metadata).toBe(before.metadata);
    expect(after.createdAt).toBe(createdAt);
    expect(after.accessCount).toBe(7);
    db.close();
  });

  it('leaves a row with no tags equally untouched', async () => {
    const db = freshV3Db();
    db.run(
      `INSERT INTO memory_entries (id, key, content, created_at) VALUES (?, ?, ?, ?)`,
      ['r2', 'k-r2', 'no tags here', 1_700_000_000_000],
    );

    const store = new SqlJsMemoryEntriesStore(db, 'memory.db');
    await migrateStore({ store, embedder: new MockBatchEmbedder(8), batchSize: 10 });

    const after = readRow(db, 'r2');
    expect(after.tags).toBeNull();
    expect(after.createdAt).toBe(1_700_000_000_000);
    expect(after.embedding).not.toBeNull();
    db.close();
  });
});
