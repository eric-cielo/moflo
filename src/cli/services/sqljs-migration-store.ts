/**
 * sql.js-backed {@link MigrationStore} adapter for moflo's memory.db.
 *
 * Implements the abstract store interface from `cli/src/embeddings/migration`
 * so the story-2 resumable re-embed driver can walk an existing `memory_entries`
 * table, re-embed the source text with the new neural model, and write the
 * updated vectors back transactionally.
 *
 * Schema assumptions — matches MEMORY_SCHEMA_V3 in
 * `src/cli/memory/memory-initializer.ts`:
 *   CREATE TABLE memory_entries (
 *     id TEXT PRIMARY KEY, key TEXT NOT NULL,
 *     content TEXT NOT NULL,
 *     embedding TEXT,              -- JSON-encoded Float32 array
 *     embedding_dimensions INTEGER,
 *     ...
 *   );
 *   CREATE TABLE migration_cursor (...);
 *   CREATE TABLE metadata (...);
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

/** Optional store-wide configuration; legacy callers can omit. */
export interface SqlJsMemoryEntriesStoreOptions {
  /**
   * Canonical model label this migration produces (e.g.
   * `'fast-all-MiniLM-L6-v2'`). When set:
   *   - `countItems()` and `iterItems()` only return rows whose
   *     `embedding_model` differs from `targetModel` (or is NULL). This
   *     turns the migration into a self-healing pass: completed rows are
   *     filtered out, surviving non-target rows (Xenova-tagged, retired
   *     hash-fallback rows from epic #527, NULL/'local' residue from #649's
   *     silent failures, etc.) are re-embedded.
   *   - `updateBatch()` writes `embedding_model = targetModel` alongside
   *     the new vector, so the post-migration label faithfully describes
   *     the producing embedder. Pre-#650 the column was untouched, which
   *     is how the live DB ended up with non-target rows surviving past
   *     a successful v2 stamp.
   *
   * Omit for the legacy "blanket re-embed without re-tagging" semantics
   * still used by the existing tests.
   */
  targetModel?: string;
}

// SQL fragment shared by countItems / iterItems / hasIneligibleRows when the
// store has a configured `targetModel`. Centralized so the eligibility rule
// stays consistent across read paths — drift here re-opens #648's failure
// mode where some queries treat a row as "done" while others don't.
const ELIGIBILITY_AND_CLAUSE = 'AND (embedding_model IS NULL OR embedding_model != ?)';

export class SqlJsMemoryEntriesStore {
  readonly storeId: string;
  private inTransaction = false;
  private readonly targetModel: string | null;

  constructor(
    private readonly db: SqlJsDatabase,
    dbFileName: string,
    options: SqlJsMemoryEntriesStoreOptions = {},
  ) {
    this.storeId = `${dbFileName}:memory_entries`;
    this.targetModel = options.targetModel ?? null;
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

  /**
   * Count rows the migration would touch. When `targetModel` is set this
   * is the count of rows NOT yet on the target — so a clean DB returns 0
   * and the migration short-circuits.
   */
  async countItems(): Promise<number> {
    const baseSql = `SELECT COUNT(*) AS n FROM memory_entries
                     WHERE content IS NOT NULL AND length(content) > 0`;
    const sql = this.targetModel === null ? baseSql : `${baseSql} ${ELIGIBILITY_AND_CLAUSE}`;
    const stmt = this.db.prepare(sql);
    try {
      if (this.targetModel !== null) stmt.bind([this.targetModel]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        return Number(row.n ?? 0);
      }
      return 0;
    } finally {
      stmt.free();
    }
  }

  /**
   * Bounded eligibility probe — `LIMIT 1` exits as soon as one ineligible row
   * is found. Used by the orchestrator's session-start short-circuit so the
   * "v2 stamped, all rows on target" common case doesn't pay for a full
   * COUNT(*). Returns false (no work needed) when called on a store with no
   * `targetModel` configured.
   */
  async hasIneligibleRows(): Promise<boolean> {
    if (this.targetModel === null) return false;
    const stmt = this.db.prepare(
      `SELECT 1 FROM memory_entries
       WHERE content IS NOT NULL AND length(content) > 0 ${ELIGIBILITY_AND_CLAUSE}
       LIMIT 1`,
    );
    try {
      stmt.bind([this.targetModel]);
      return stmt.step();
    } finally {
      stmt.free();
    }
  }

  /**
   * Iterate rows the migration should re-embed. With `targetModel` set,
   * already-target rows are filtered out — interrupted runs naturally
   * resume only on stragglers, and a finished run yields no rows at all.
   */
  async iterItems(afterId: string | null, limit: number): Promise<MigrationItemRow[]> {
    const eligibilityClause = this.targetModel === null ? '' : ELIGIBILITY_AND_CLAUSE;

    const sql = afterId === null
      ? `SELECT id, content FROM memory_entries
         WHERE content IS NOT NULL AND length(content) > 0
           ${eligibilityClause}
         ORDER BY id ASC LIMIT ?`
      : `SELECT id, content FROM memory_entries
         WHERE content IS NOT NULL AND length(content) > 0 AND id > ?
           ${eligibilityClause}
         ORDER BY id ASC LIMIT ?`;

    const stmt = this.db.prepare(sql);
    try {
      const params: unknown[] = [];
      if (afterId !== null) params.push(afterId);
      if (this.targetModel !== null) params.push(this.targetModel);
      params.push(limit);
      stmt.bind(params);
      const out: MigrationItemRow[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        out.push({ id: String(row.id), sourceText: String(row.content ?? '') });
      }
      return out;
    } finally {
      stmt.free();
    }
  }

  async updateBatch(updates: readonly { id: string; embedding: Float32Array }[]): Promise<void> {
    if (updates.length === 0) return;
    // Embeddings are stored as JSON text in MEMORY_SCHEMA_V3's `embedding TEXT`
    // column — matches how `memory-initializer.ts` and `commands/memory.ts`
    // write them so `embeddings search` can JSON.parse() the result.
    //
    // When `targetModel` is configured the UPDATE also re-tags the row so
    // post-migration `embedding_model` faithfully describes the producing
    // embedder. Pre-#650 the column was left untouched, which let
    // mixed-model rows survive past a successful v2 stamp.
    const stmt = this.targetModel === null
      ? this.db.prepare(
          `UPDATE memory_entries SET embedding = ?, embedding_dimensions = ? WHERE id = ?`,
        )
      : this.db.prepare(
          `UPDATE memory_entries
           SET embedding = ?, embedding_dimensions = ?, embedding_model = ?
           WHERE id = ?`,
        );
    try {
      for (const { id, embedding } of updates) {
        const json = JSON.stringify(Array.from(embedding));
        const params = this.targetModel === null
          ? [json, embedding.length, id]
          : [json, embedding.length, this.targetModel, id];
        stmt.run(params);
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
