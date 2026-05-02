/**
 * Unit tests for the #728 soft-delete elimination + upgrade purge.
 *
 * Covers:
 *  - `purgeSoftDeletedEntries` hard-deletes leftover `status='deleted'` rows.
 *  - `archived` rows survive the purge (the legitimate "keep but hide" state).
 *  - The new schema CHECK constraint rejects `status='deleted'` on insert.
 *  - The purge is idempotent (no-op on a clean DB).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { purgeSoftDeletedEntries } from '../../services/soft-delete-purge.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeLegacyDb as makeLegacyMemoryDb } from '../_helpers/legacy-memory-db.js';

type SqlJsDb = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
};
type SqlJsStatic = { Database: new (data?: Uint8Array) => SqlJsDb };

let SQL: SqlJsStatic;

beforeAll(async () => {
  const initSqlJs = (await import('sql.js')).default;
  SQL = (await initSqlJs()) as SqlJsStatic;
});

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal — Windows occasionally holds file handles */
    }
  }
});

async function makeTmpDb(setup: (db: SqlJsDb) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  const db = new SQL.Database();
  db.run(MEMORY_SCHEMA_V3);
  setup(db);
  const bytes = db.export();
  db.close();
  await writeFile(dbPath, Buffer.from(bytes));
  return dbPath;
}

/**
 * Older moflo schema permitted `status='deleted'`. The shared helper uses
 * the same legacy CHECK constraint we need to seed tombstones with, since
 * the live V3 schema rejects the value outright (which is exactly what we
 * test separately in the schema-rejection assertion).
 */
async function makeLegacyDb(setup: (db: SqlJsDb) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-legacy-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  await makeLegacyMemoryDb(SQL, dbPath, setup);
  return dbPath;
}

function countByStatus(dbBytes: Uint8Array, status: string): number {
  const db = new SQL.Database(dbBytes);
  try {
    const rows = db.exec(
      `SELECT COUNT(*) FROM memory_entries WHERE status = '${status}'`,
    );
    return Number(rows[0]?.values?.[0]?.[0] ?? 0);
  } finally {
    db.close();
  }
}

describe('purgeSoftDeletedEntries (#728)', () => {
  it('returns purged: 0 when the DB file does not exist', async () => {
    const result = await purgeSoftDeletedEntries({
      dbPath: join(tmpdir(), 'moflo-missing-728', 'nope.db'),
    });
    expect(result).toEqual({ purged: 0 });
  });

  it('hard-deletes status=deleted rows and preserves archived rows', async () => {
    const dbPath = await makeLegacyDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)`,
        ['t1', 'k1', 'hive-mind', 'tombstone-1', 'deleted'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)`,
        ['t2', 'k2', 'hive-mind', 'tombstone-2', 'deleted'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)`,
        ['a1', 'archived-key', 'patterns', 'keep-me', 'archived'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)`,
        ['live', 'active-key', 'patterns', 'live-row', 'active'],
      );
    });

    const result = await purgeSoftDeletedEntries({ dbPath });
    expect(result.purged).toBe(2);

    const after = await readFile(dbPath);
    expect(countByStatus(after, 'deleted')).toBe(0);
    expect(countByStatus(after, 'archived')).toBe(1);
    expect(countByStatus(after, 'active')).toBe(1);
  });

  it('is idempotent: a clean DB returns purged: 0 without writing', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)`,
        ['live', 'k', 'patterns', 'c', 'active'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)`,
        ['arc', 'k2', 'patterns', 'c', 'archived'],
      );
    });

    const before = await readFile(dbPath);
    const result = await purgeSoftDeletedEntries({ dbPath });
    expect(result).toEqual({ purged: 0 });

    // No write means the file bytes are unchanged.
    const after = await readFile(dbPath);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it('skips DBs that lack a memory_entries table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-other-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'something.db');
    const db = new SQL.Database();
    db.run(`CREATE TABLE other_table (id TEXT PRIMARY KEY);`);
    const bytes = db.export();
    db.close();
    await writeFile(dbPath, Buffer.from(bytes));

    const result = await purgeSoftDeletedEntries({ dbPath });
    expect(result).toEqual({ purged: 0 });
  });
});

describe('memory_entries CHECK constraint (#728)', () => {
  it("rejects status='deleted' on insert against the new schema", async () => {
    const db = new SQL.Database();
    db.run(MEMORY_SCHEMA_V3);
    expect(() => {
      db.run(
        `INSERT INTO memory_entries (id, key, content, status) VALUES (?, ?, ?, ?)`,
        ['x', 'k', 'c', 'deleted'],
      );
    }).toThrow(/CHECK constraint/i);
    db.close();
  });

  it("accepts status='archived' on insert against the new schema", async () => {
    const db = new SQL.Database();
    db.run(MEMORY_SCHEMA_V3);
    db.run(
      `INSERT INTO memory_entries (id, key, content, status) VALUES (?, ?, ?, ?)`,
      ['x', 'k', 'c', 'archived'],
    );
    const rows = db.exec(`SELECT status FROM memory_entries WHERE id='x'`);
    expect(rows[0]?.values?.[0]?.[0]).toBe('archived');
    db.close();
  });
});
