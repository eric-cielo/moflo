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
 *
 * Phase 5 (#1084): node:sqlite-only. The sql.js-shaped `SQL.Database` API
 * was removed; tests now pass the `DatabaseSync` constructor directly.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

/**
 * Minimal db-callback shape exposed to setup functions. Matches the surface
 * each test fixture actually uses (run for DDL, prepare for parameterised
 * INSERTs). Intentionally narrow so swapping the engine again doesn't
 * cascade through every test.
 */
export interface FixtureDb {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): FixtureStatement;
}

export interface FixtureStatement {
  run(params?: unknown[]): void;
  free(): void;
}

function wrap(db: DatabaseSync): FixtureDb {
  return {
    run(sql: string, params?: unknown[]) {
      if (params && params.length > 0) {
        const s = db.prepare(sql);
        try {
          s.run(...(params as unknown[]));
        } finally {
          // node:sqlite StatementSync has no explicit free; GC handles it.
        }
      } else {
        db.exec(sql);
      }
    },
    prepare(sql: string) {
      const s = db.prepare(sql);
      return {
        run(params?: unknown[]) {
          if (params && params.length > 0) s.run(...(params as unknown[]));
          else s.run();
        },
        free() { /* no-op under node:sqlite */ },
      };
    },
  };
}

/**
 * Build a node:sqlite DB at `dbPath` with `schema`, run `setup` against it,
 * close. Creates parent dirs as needed.
 */
export async function makeMemoryDb(
  dbPath: string,
  schema: string,
  setup: (db: FixtureDb) => void,
): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(schema);
    setup(wrap(db));
  } finally {
    db.close();
  }
}

/** Convenience wrapper using the legacy CHECK schema. */
export function makeLegacyDb(
  dbPath: string,
  setup: (db: FixtureDb) => void,
): Promise<void> {
  return makeMemoryDb(dbPath, LEGACY_MEMORY_SCHEMA, setup);
}
