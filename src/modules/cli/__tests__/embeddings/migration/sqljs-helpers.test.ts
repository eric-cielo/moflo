/**
 * Tests for sqljs-helpers — the shared cursor/version utilities every real
 * store adapter uses. Runs against an in-memory sql.js database so it
 * exercises the actual SQL, not a mock.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import {
  EMBEDDINGS_VERSION_KEY,
  clearCursorRow,
  ensureCursorTable,
  ensureMetadataTable,
  loadCursorRow,
  readEmbeddingsVersion,
  saveCursorRow,
  writeEmbeddingsVersion,
  type SqlJsDatabase,
} from '../../../src/embeddings/migration/index.js';

// Shared sql.js module, loaded once.
type SqlJsStatic = { Database: new () => SqlJsDatabase };
let SQL: SqlJsStatic;

beforeAll(async () => {
  const initSqlJs = (await import('sql.js')).default;
  SQL = (await initSqlJs()) as SqlJsStatic;
});

function freshDb(): SqlJsDatabase {
  return new SQL.Database();
}

describe('version marker helpers', () => {
  it('returns null when no metadata table exists', () => {
    const db = freshDb();
    expect(readEmbeddingsVersion(db)).toBeNull();
  });

  it('returns null when marker row is absent', () => {
    const db = freshDb();
    ensureMetadataTable(db);
    expect(readEmbeddingsVersion(db)).toBeNull();
  });

  it('round-trips the version', () => {
    const db = freshDb();
    writeEmbeddingsVersion(db, 2);
    expect(readEmbeddingsVersion(db)).toBe(2);
  });

  it('upserts rather than duplicating the row', () => {
    const db = freshDb();
    writeEmbeddingsVersion(db, 1);
    writeEmbeddingsVersion(db, 2);
    writeEmbeddingsVersion(db, 3);
    expect(readEmbeddingsVersion(db)).toBe(3);
    const count = db.exec(
      `SELECT COUNT(*) FROM metadata WHERE key = '${EMBEDDINGS_VERSION_KEY}'`,
    );
    expect(Number(count[0]!.values[0]![0])).toBe(1);
  });

  it('uses the shared `metadata` table so it coexists with existing keys', () => {
    const db = freshDb();
    ensureMetadataTable(db);
    db.run(`INSERT INTO metadata (key, value) VALUES ('schema_version', '3.0.0')`);
    writeEmbeddingsVersion(db, 2);
    expect(readEmbeddingsVersion(db)).toBe(2);
    const otherResult = db.exec(
      `SELECT value FROM metadata WHERE key = 'schema_version'`,
    );
    expect(String(otherResult[0]!.values[0]![0])).toBe('3.0.0');
  });
});

describe('cursor helpers', () => {
  const now = 1_700_000_000_000;

  it('returns null when the cursor row is absent', () => {
    const db = freshDb();
    expect(loadCursorRow(db, 'my-store')).toBeNull();
  });

  it('round-trips a cursor', () => {
    const db = freshDb();
    saveCursorRow(db, {
      storeId: 'mem:entries',
      lastProcessedId: 'id-0042',
      itemsDone: 42,
      itemsTotal: 100,
      startedAt: now,
      updatedAt: now + 500,
    });
    const loaded = loadCursorRow(db, 'mem:entries');
    expect(loaded).toEqual({
      storeId: 'mem:entries',
      lastProcessedId: 'id-0042',
      itemsDone: 42,
      itemsTotal: 100,
      startedAt: now,
      updatedAt: now + 500,
    });
  });

  it('scopes rows by store id — multiple stores in one DB do not collide', () => {
    const db = freshDb();
    saveCursorRow(db, {
      storeId: 'memory:entries',
      lastProcessedId: 'a-100',
      itemsDone: 100,
      itemsTotal: 200,
      startedAt: now,
      updatedAt: now,
    });
    saveCursorRow(db, {
      storeId: 'memory:patterns',
      lastProcessedId: 'p-7',
      itemsDone: 7,
      itemsTotal: 20,
      startedAt: now,
      updatedAt: now,
    });

    const entries = loadCursorRow(db, 'memory:entries');
    const patterns = loadCursorRow(db, 'memory:patterns');
    expect(entries?.itemsDone).toBe(100);
    expect(patterns?.itemsDone).toBe(7);
  });

  it('upserts on repeated save', () => {
    const db = freshDb();
    saveCursorRow(db, {
      storeId: 's',
      lastProcessedId: 'x-1',
      itemsDone: 1,
      itemsTotal: 10,
      startedAt: now,
      updatedAt: now,
    });
    saveCursorRow(db, {
      storeId: 's',
      lastProcessedId: 'x-5',
      itemsDone: 5,
      itemsTotal: 10,
      startedAt: now,
      updatedAt: now + 10,
    });
    expect(loadCursorRow(db, 's')?.itemsDone).toBe(5);
  });

  it('clearCursorRow removes only the targeted store', () => {
    const db = freshDb();
    saveCursorRow(db, {
      storeId: 'a',
      lastProcessedId: 'a-1',
      itemsDone: 1,
      itemsTotal: 2,
      startedAt: now,
      updatedAt: now,
    });
    saveCursorRow(db, {
      storeId: 'b',
      lastProcessedId: 'b-1',
      itemsDone: 1,
      itemsTotal: 2,
      startedAt: now,
      updatedAt: now,
    });

    clearCursorRow(db, 'a');
    expect(loadCursorRow(db, 'a')).toBeNull();
    expect(loadCursorRow(db, 'b')).not.toBeNull();
  });

  it('ensureCursorTable is idempotent', () => {
    const db = freshDb();
    ensureCursorTable(db);
    ensureCursorTable(db);
    ensureCursorTable(db);
    saveCursorRow(db, {
      storeId: 's',
      lastProcessedId: null,
      itemsDone: 0,
      itemsTotal: 5,
      startedAt: now,
      updatedAt: now,
    });
    expect(loadCursorRow(db, 's')?.lastProcessedId).toBeNull();
  });
});
