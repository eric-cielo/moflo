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
import { CANONICAL_EMBEDDING_MODEL } from '../../embeddings/migration/types.js';

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

// ── Story 2 / #650: eligibility-aware short-circuit ──────────────────────────
// These tests exercise the orchestrator's "should we run?" logic without
// touching fastembed — when there are no eligible rows the orchestrator
// short-circuits before constructing an embedder. The end-to-end repair
// behavior is covered at the store layer in sqljs-migration-store-v3.test.ts.

describe('runEmbeddingsMigrationIfNeeded — eligibility short-circuit (#650)', () => {
  /** Apply MEMORY_SCHEMA_V3 to a fresh in-memory DB, then export to disk. */
  async function makeV3Db(setup?: (db: SqlJsDb & { exec(sql: string): unknown }) => void): Promise<string> {
    const { MEMORY_SCHEMA_V3 } = await import('../../memory/memory-initializer.js');
    const dir = await mkdtemp(join(tmpdir(), 'moflo-migration-elig-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'memory.db');
    const db = new SQL.Database() as SqlJsDb & { exec(sql: string): unknown };
    db.run(MEMORY_SCHEMA_V3);
    if (setup) setup(db);
    const bytes = db.export();
    db.close();
    await writeFile(dbPath, Buffer.from(bytes));
    return dbPath;
  }

  async function readVersion(dbPath: string): Promise<number | null> {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(dbPath);
    const db = new SQL.Database(bytes) as SqlJsDb & {
      exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    };
    try {
      const res = db.exec(`SELECT value FROM metadata WHERE key='embeddings_version'`);
      const row = res[0]?.values[0];
      return row ? Number(row[0]) : null;
    } finally {
      db.close();
    }
  }

  // Use the canonical constant so a rename ripples through automatically.
  const TARGET_MODEL = CANONICAL_EMBEDDING_MODEL;

  /** No-op WritableStream for test runs so the renderer doesn't dirty output. */
  const silentOut = {
    write: () => true,
    isTTY: false,
  } as unknown as NodeJS.WritableStream & { isTTY?: boolean };

  it('runs the driver on a fresh DB and bumps version to v2 with zero items', async () => {
    const dbPath = await makeV3Db();
    const ran = await runEmbeddingsMigrationIfNeeded({ dbPath, out: silentOut });
    // Fresh DB had no version stamp → short-circuit doesn't fire → driver
    // runs, sees 0 items, bumps version, exits success. The orchestrator
    // returns true because the driver completed.
    expect(ran).toBe(true);
    expect(await readVersion(dbPath)).toBe(2);
  });

  it('skips a v2-stamped DB whose rows are all on the target model', async () => {
    const dbPath = await makeV3Db((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, content, embedding, embedding_dimensions, embedding_model)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['a', 'k-a', 'content-a', JSON.stringify([0.1, 0.2]), 2, TARGET_MODEL],
      );
      db.run(
        `INSERT INTO metadata (key, value) VALUES ('embeddings_version', '2')`,
      );
    });
    const ran = await runEmbeddingsMigrationIfNeeded({ dbPath });
    expect(ran).toBe(false); // clean DB — short-circuit before driver loads
    expect(await readVersion(dbPath)).toBe(2);
  });
});
