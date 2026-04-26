/**
 * Unit tests for `runEmbeddingsMigrationIfNeeded`.
 *
 * Covers the probe behaviour added for #547 — specifically that the migration
 * only runs against DBs whose `memory_entries` table carries every column the
 * driver reads or writes. A DB with just `embedding` but no `content` or
 * `embedding_dimensions` used to pass the old probe and then throw mid-run.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEmbeddingsMigrationIfNeeded } from '../../services/embeddings-migration.js';

type SqlJsDb = {
  run(sql: string, params?: unknown[]): void;
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

async function makeTmpDb(schema: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-migration-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  const db = new SQL.Database();
  db.run(schema);
  const bytes = db.export();
  db.close();
  await writeFile(dbPath, Buffer.from(bytes));
  return dbPath;
}

describe('runEmbeddingsMigrationIfNeeded', () => {
  it('returns false when the DB file does not exist', async () => {
    const ran = await runEmbeddingsMigrationIfNeeded({
      dbPath: join(tmpdir(), 'moflo-missing-', 'nope.db'),
    });
    expect(ran).toBe(false);
  });

  it('returns false for a DB lacking the v3 `content` column', async () => {
    // Legacy schema: had `value` instead of `content`. The old probe only
    // checked `embedding` and passed — then crashed on SELECT value. Now
    // the probe requires the full v3 column set, so we skip cleanly.
    const dbPath = await makeTmpDb(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        key TEXT,
        value TEXT,
        embedding BLOB,
        dimensions INTEGER
      );
    `);
    expect(existsSync(dbPath)).toBe(true);
    const ran = await runEmbeddingsMigrationIfNeeded({ dbPath });
    expect(ran).toBe(false);
  });

  it('returns false for a DB lacking embedding_dimensions', async () => {
    const dbPath = await makeTmpDb(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        key TEXT,
        content TEXT NOT NULL,
        embedding TEXT
      );
    `);
    const ran = await runEmbeddingsMigrationIfNeeded({ dbPath });
    expect(ran).toBe(false);
  });

  it('returns false when no memory_entries table exists at all', async () => {
    const dbPath = await makeTmpDb(`
      CREATE TABLE unrelated (id TEXT PRIMARY KEY, value TEXT);
    `);
    const ran = await runEmbeddingsMigrationIfNeeded({ dbPath });
    expect(ran).toBe(false);
  });
});
