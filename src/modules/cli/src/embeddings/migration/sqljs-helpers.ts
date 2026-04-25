/**
 * Generic sql.js helpers for the migration driver.
 *
 * Two pieces of infrastructure live inside each target store's DB:
 *
 *   1. A `metadata` key/value table that carries the `embeddings_version`
 *      marker. Most moflo stores already have one; this helper guards the
 *      DDL with `IF NOT EXISTS` so it's safe to run against either.
 *
 *   2. An `embeddings_migration_cursor` table that persists the resume
 *      cursor per-store (so multiple stores sharing a DB file — e.g.
 *      `.swarm/memory.db` with both `memory_entries` and `patterns` —
 *      each get their own row).
 *
 * The helpers are framework-agnostic: they accept a minimal `SqlJsDatabase`
 * interface so callers can use `sql.js` directly or wrap it.
 *
 * @module cli/embeddings/migration/sqljs-helpers
 */

import type { MigrationCursor } from './types.js';

/**
 * Minimal shape we need from a sql.js `Database` — matches what the moflo
 * memory and embeddings modules already use, without taking a hard type
 * dependency on `sql.js`.
 */
export interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlJsStatement;
}

export interface SqlJsStatement {
  bind(params: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

// --------------------------------------------------------------------------
// Version marker (in the shared `metadata` table)
// --------------------------------------------------------------------------

export const EMBEDDINGS_VERSION_KEY = 'embeddings_version';

const METADATA_DDL = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  )
`;

export function ensureMetadataTable(db: SqlJsDatabase): void {
  db.run(METADATA_DDL);
}

export function readEmbeddingsVersion(db: SqlJsDatabase): number | null {
  ensureMetadataTable(db);
  const result = db.exec(
    `SELECT value FROM metadata WHERE key = '${EMBEDDINGS_VERSION_KEY}'`,
  );
  const raw = result[0]?.values[0]?.[0];
  if (raw === undefined || raw === null) return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function writeEmbeddingsVersion(db: SqlJsDatabase, version: number): void {
  ensureMetadataTable(db);
  db.run(
    `INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, strftime('%s', 'now') * 1000)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [EMBEDDINGS_VERSION_KEY, String(version)],
  );
}

// --------------------------------------------------------------------------
// Resume cursor table
// --------------------------------------------------------------------------

const CURSOR_DDL = `
  CREATE TABLE IF NOT EXISTS embeddings_migration_cursor (
    store_id TEXT PRIMARY KEY,
    last_processed_id TEXT,
    items_done INTEGER NOT NULL DEFAULT 0,
    items_total INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

export function ensureCursorTable(db: SqlJsDatabase): void {
  db.run(CURSOR_DDL);
}

export function loadCursorRow(db: SqlJsDatabase, storeId: string): MigrationCursor | null {
  ensureCursorTable(db);
  const stmt = db.prepare(
    `SELECT store_id, last_processed_id, items_done, items_total, started_at, updated_at
     FROM embeddings_migration_cursor WHERE store_id = ?`,
  );
  stmt.bind([storeId]);
  try {
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    return {
      storeId: String(row.store_id),
      lastProcessedId:
        row.last_processed_id === null || row.last_processed_id === undefined
          ? null
          : String(row.last_processed_id),
      itemsDone: Number(row.items_done ?? 0),
      itemsTotal: Number(row.items_total ?? 0),
      startedAt: Number(row.started_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  } finally {
    stmt.free();
  }
}

export function saveCursorRow(db: SqlJsDatabase, cursor: MigrationCursor): void {
  ensureCursorTable(db);
  db.run(
    `INSERT INTO embeddings_migration_cursor
       (store_id, last_processed_id, items_done, items_total, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id) DO UPDATE SET
       last_processed_id = excluded.last_processed_id,
       items_done        = excluded.items_done,
       items_total       = excluded.items_total,
       updated_at        = excluded.updated_at`,
    [
      cursor.storeId,
      cursor.lastProcessedId,
      cursor.itemsDone,
      cursor.itemsTotal,
      cursor.startedAt,
      cursor.updatedAt,
    ],
  );
}

export function clearCursorRow(db: SqlJsDatabase, storeId: string): void {
  ensureCursorTable(db);
  db.run(`DELETE FROM embeddings_migration_cursor WHERE store_id = ?`, [storeId]);
}
