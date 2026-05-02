/**
 * Shared test helper for staging a legacy `memory_entries` SQLite DB.
 *
 * Pre-V3 moflo permitted `status='deleted'` rows; the V3 schema CHECK
 * constraint rejects that value outright. Tests that simulate an upgrade
 * scenario (cherry-pick #851, soft-delete purge #728, ephemeral purge #729)
 * need the legacy CHECK so they can seed tombstones / older statuses without
 * fighting the live schema. Centralizing the DDL here keeps the schema in
 * one place — the next purge/migration test reuses it instead of pasting a
 * fourth copy.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const LEGACY_MEMORY_SCHEMA = `
  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    namespace TEXT DEFAULT 'default',
    content TEXT NOT NULL,
    type TEXT,
    embedding TEXT,
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    tags TEXT,
    metadata TEXT,
    owner_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
    UNIQUE(namespace, key)
  );
`;

export interface SqlJsLikeDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

export interface SqlJsLikeStatic {
  Database: new (data?: Uint8Array) => SqlJsLikeDb;
}

/**
 * Build an in-memory DB with `schema`, run `setup` against it, and write
 * the bytes to `dbPath`. Creates parent dirs as needed.
 */
export async function makeMemoryDb(
  SQL: SqlJsLikeStatic,
  dbPath: string,
  schema: string,
  setup: (db: SqlJsLikeDb) => void,
): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new SQL.Database();
  db.run(schema);
  setup(db);
  const bytes = db.export();
  db.close();
  await writeFile(dbPath, Buffer.from(bytes));
}

/** Convenience wrapper using the legacy CHECK schema. */
export function makeLegacyDb(
  SQL: SqlJsLikeStatic,
  dbPath: string,
  setup: (db: SqlJsLikeDb) => void,
): Promise<void> {
  return makeMemoryDb(SQL, dbPath, LEGACY_MEMORY_SCHEMA, setup);
}
