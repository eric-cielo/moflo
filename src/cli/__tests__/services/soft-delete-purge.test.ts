/**
 * Unit tests for the #728 soft-delete elimination + upgrade purge.
 *
 * Covers:
 *  - `purgeSoftDeletedEntries` hard-deletes leftover `status='deleted'` rows.
 *  - `archived` rows survive the purge (the legitimate "keep but hide" state).
 *  - The new schema CHECK constraint rejects `status='deleted'` on insert.
 *  - The purge is idempotent (no-op on a clean DB).
 *
 * Phase 5 (#1084): node:sqlite only. sql.js removed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { purgeSoftDeletedEntries } from '../../services/soft-delete-purge.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import {
  makeLegacyDb as makeLegacyMemoryDb,
  makeMemoryDb,
  type FixtureDb,
} from '../_helpers/legacy-memory-db.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* non-fatal — Windows occasionally holds file handles */
    }
  }
});

async function makeTmpDb(setup: (db: FixtureDb) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  await makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, setup);
  return dbPath;
}

/**
 * Older moflo schema permitted `status='deleted'`. The shared helper uses
 * the same legacy CHECK constraint we need to seed tombstones with, since
 * the live V3 schema rejects the value outright (which is exactly what we
 * test separately in the schema-rejection assertion).
 */
async function makeLegacyDb(setup: (db: FixtureDb) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-legacy-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  await makeLegacyMemoryDb(dbPath, setup);
  return dbPath;
}

function countByStatus(dbPath: string, status: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM memory_entries WHERE status = ?`,
    ).get(status) as { c: number | bigint } | undefined;
    return Number(row?.c ?? 0);
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

    expect(countByStatus(dbPath, 'deleted')).toBe(0);
    expect(countByStatus(dbPath, 'archived')).toBe(1);
    expect(countByStatus(dbPath, 'active')).toBe(1);
  });

  it('is idempotent: a clean DB returns purged: 0', async () => {
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

    const result = await purgeSoftDeletedEntries({ dbPath });
    expect(result).toEqual({ purged: 0 });

    // Both rows still present, untouched.
    expect(countByStatus(dbPath, 'active')).toBe(1);
    expect(countByStatus(dbPath, 'archived')).toBe(1);
    expect(countByStatus(dbPath, 'deleted')).toBe(0);
  });

  it('skips DBs that lack a memory_entries table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-other-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'something.db');
    await makeMemoryDb(dbPath, `CREATE TABLE other_table (id TEXT PRIMARY KEY);`, () => {
      /* no rows needed — just the wrong-schema table */
    });

    const result = await purgeSoftDeletedEntries({ dbPath });
    expect(result).toEqual({ purged: 0 });
  });
});

describe('memory_entries CHECK constraint (#728)', () => {
  it("rejects status='deleted' on insert against the new schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-check-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(MEMORY_SCHEMA_V3);
      expect(() => {
        db.prepare(
          `INSERT INTO memory_entries (id, key, content, status) VALUES (?, ?, ?, ?)`,
        ).run('x', 'k', 'c', 'deleted');
      }).toThrow(/CHECK constraint/i);
    } finally {
      db.close();
    }
  });

  it("accepts status='archived' on insert against the new schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-purge-check-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(MEMORY_SCHEMA_V3);
      db.prepare(
        `INSERT INTO memory_entries (id, key, content, status) VALUES (?, ?, ?, ?)`,
      ).run('x', 'k', 'c', 'archived');
      const row = db.prepare(`SELECT status FROM memory_entries WHERE id='x'`).get() as {
        status: string;
      };
      expect(row.status).toBe('archived');
    } finally {
      db.close();
    }
  });
});
