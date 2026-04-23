/**
 * sql.js-backed {@link MigrationStore} adapter for moflo's memory.db.
 *
 * Implements the abstract store interface from `@moflo/embeddings/migration`
 * so the story-2 resumable re-embed driver can walk an existing `memory_entries`
 * table, re-embed the source text with the new neural model, and write the
 * updated vectors back transactionally.
 *
 * Schema assumptions (matches moflo's memory-initializer):
 *   CREATE TABLE memory_entries (id TEXT PRIMARY KEY, key TEXT, value TEXT,
 *                                embedding BLOB, dimensions INTEGER, ...);
 *   CREATE TABLE migration_cursor (store_id TEXT PRIMARY KEY, last_id TEXT,
 *                                  items_done INTEGER, items_total INTEGER,
 *                                  started_at INTEGER, updated_at INTEGER);
 *   CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
 *
 * Tables are created lazily if missing so the adapter works on older DBs.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const EMBEDDINGS_VERSION_KEY = 'embeddings_version';

interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): unknown;
}

interface SqlJsStatement {
  bind(params: unknown[]): boolean;
  step(): boolean;
  get(): unknown[];
  getAsObject(): Record<string, unknown>;
  free(): void;
  run(params?: unknown[]): void;
}

export interface MigrationItemRow {
  id: string;
  sourceText: string;
}

export class SqlJsMemoryEntriesStore {
  readonly storeId: string;
  private inTransaction = false;

  constructor(private readonly db: SqlJsDatabase, dbFileName: string) {
    this.storeId = `${dbFileName}:memory_entries`;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS migration_cursor (
        store_id TEXT PRIMARY KEY,
        last_id TEXT,
        items_done INTEGER NOT NULL DEFAULT 0,
        items_total INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async countItems(): Promise<number> {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM memory_entries WHERE value IS NOT NULL AND length(value) > 0`,
    );
    try {
      if (stmt.step()) {
        const row = stmt.getAsObject();
        return Number(row.n ?? 0);
      }
      return 0;
    } finally {
      stmt.free();
    }
  }

  async iterItems(afterId: string | null, limit: number): Promise<MigrationItemRow[]> {
    const sql = afterId === null
      ? `SELECT id, value FROM memory_entries
         WHERE value IS NOT NULL AND length(value) > 0
         ORDER BY id ASC LIMIT ?`
      : `SELECT id, value FROM memory_entries
         WHERE value IS NOT NULL AND length(value) > 0 AND id > ?
         ORDER BY id ASC LIMIT ?`;

    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(afterId === null ? [limit] : [afterId, limit]);
      const out: MigrationItemRow[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        out.push({ id: String(row.id), sourceText: String(row.value ?? '') });
      }
      return out;
    } finally {
      stmt.free();
    }
  }

  async updateBatch(updates: readonly { id: string; embedding: Float32Array }[]): Promise<void> {
    if (updates.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE memory_entries SET embedding = ?, dimensions = ? WHERE id = ?`,
    );
    try {
      for (const { id, embedding } of updates) {
        const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        stmt.run([buf, embedding.length, id]);
      }
    } finally {
      stmt.free();
    }
  }

  async saveCursor(cursor: {
    storeId: string;
    lastProcessedId: string | null;
    itemsDone: number;
    itemsTotal: number;
    startedAt: number;
    updatedAt: number;
  }): Promise<void> {
    this.db.run(
      `INSERT INTO migration_cursor (store_id, last_id, items_done, items_total, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id) DO UPDATE SET
         last_id = excluded.last_id,
         items_done = excluded.items_done,
         items_total = excluded.items_total,
         updated_at = excluded.updated_at`,
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

  async loadCursor(): Promise<{
    storeId: string;
    lastProcessedId: string | null;
    itemsDone: number;
    itemsTotal: number;
    startedAt: number;
    updatedAt: number;
  } | null> {
    const stmt = this.db.prepare(
      `SELECT store_id, last_id, items_done, items_total, started_at, updated_at
       FROM migration_cursor WHERE store_id = ?`,
    );
    try {
      stmt.bind([this.storeId]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject();
      return {
        storeId: String(row.store_id),
        lastProcessedId: row.last_id === null ? null : String(row.last_id),
        itemsDone: Number(row.items_done ?? 0),
        itemsTotal: Number(row.items_total ?? 0),
        startedAt: Number(row.started_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
      };
    } finally {
      stmt.free();
    }
  }

  async clearCursor(): Promise<void> {
    this.db.run(`DELETE FROM migration_cursor WHERE store_id = ?`, [this.storeId]);
  }

  async getVersion(): Promise<number | null> {
    const stmt = this.db.prepare(`SELECT value FROM metadata WHERE key = ?`);
    try {
      stmt.bind([EMBEDDINGS_VERSION_KEY]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject();
      const parsed = Number(row.value);
      return Number.isFinite(parsed) ? parsed : null;
    } finally {
      stmt.free();
    }
  }

  async setVersion(version: number): Promise<void> {
    this.db.run(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [EMBEDDINGS_VERSION_KEY, String(version)],
    );
  }

  async beginTransaction(): Promise<void> {
    if (this.inTransaction) return;
    this.db.run('BEGIN');
    this.inTransaction = true;
  }

  async commit(): Promise<void> {
    if (!this.inTransaction) return;
    this.db.run('COMMIT');
    this.inTransaction = false;
  }

  async rollback(): Promise<void> {
    if (!this.inTransaction) return;
    this.db.run('ROLLBACK');
    this.inTransaction = false;
  }
}
