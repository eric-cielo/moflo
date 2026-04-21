/**
 * BatchOperations — moflo-owned bulk insert/update/delete (epic #464 Phase C2).
 *
 * Replaces `agentdb.BatchOperations`. Wraps sql.js transactions so bulk
 * operations are atomic (all-or-nothing per batch).
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   - insertEpisodes([{content, metadata?, embedding?}])
 *   - bulkDelete(table, conditions)
 *   - bulkUpdate(table, updates, conditions)
 *
 * Only the `episodes` table is whitelisted for delete/update to keep the
 * SQL surface narrow; attempts to target any other table throw.
 */

import { randomBytes } from 'node:crypto';
import type { EpisodeInput, SqlJsDatabaseLike } from './types.js';

const EPISODES_TABLE = 'moflo_episodes';
const ALLOWED_TABLES = new Set(['episodes']);

export interface BatchInsertResult {
  inserted: number;
  ids: string[];
}

export interface BatchDeleteResult {
  deleted: number;
}

export interface BatchUpdateResult {
  updated: number;
}

export class BatchOperations {
  private db: SqlJsDatabaseLike;

  constructor(db: SqlJsDatabaseLike, _embedder?: unknown) {
    if (!db) throw new Error('BatchOperations requires a sql.js Database');
    this.db = db;
    // _embedder accepted for API-compatibility with agentdb's constructor
    // signature; moflo's impl never computes embeddings at bulk-insert time.
    this.ensureSchema();
  }

  async insertEpisodes(episodes: EpisodeInput[]): Promise<BatchInsertResult> {
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { inserted: 0, ids: [] };
    }
    const ids: string[] = [];
    const now = Date.now();
    this.db.run('BEGIN TRANSACTION');
    try {
      const stmt = this.db.prepare(
        `INSERT INTO ${EPISODES_TABLE} (id, key, content, metadata, embedding, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const ep of episodes) {
          const id = generateId();
          const meta = ep.metadata ?? {};
          const key = typeof (meta as any).key === 'string' ? (meta as any).key : id;
          const content = typeof ep.content === 'string' ? ep.content : String(ep.content ?? '');
          const embeddingBlob = serializeEmbedding(ep.embedding);
          stmt.run?.([id, key, content, JSON.stringify(meta), embeddingBlob, now]);
          ids.push(id);
        }
      } finally {
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    return { inserted: ids.length, ids };
  }

  async bulkDelete(table: string, conditions: Record<string, unknown>): Promise<BatchDeleteResult> {
    const realTable = this.resolveTable(table);
    const { whereSql, values } = buildWhere(conditions);
    if (!whereSql) {
      // Refuse unbounded deletes — easy footgun.
      throw new Error('bulkDelete requires at least one condition');
    }
    const before = this.tableCount(realTable);
    this.db.run(`DELETE FROM ${realTable} WHERE ${whereSql}`, values);
    const after = this.tableCount(realTable);
    return { deleted: Math.max(0, before - after) };
  }

  async bulkUpdate(
    table: string,
    updates: Record<string, unknown>,
    conditions: Record<string, unknown>,
  ): Promise<BatchUpdateResult> {
    const realTable = this.resolveTable(table);
    const updateKeys = Object.keys(updates ?? {});
    if (updateKeys.length === 0) return { updated: 0 };

    const setClauses: string[] = [];
    const setValues: unknown[] = [];
    for (const col of updateKeys) {
      if (!isSafeIdent(col)) {
        throw new Error(`bulkUpdate: unsafe column identifier '${col}'`);
      }
      setClauses.push(`${col} = ?`);
      setValues.push(normalizeValue(updates[col]));
    }

    const { whereSql, values: whereValues } = buildWhere(conditions);
    if (!whereSql) {
      throw new Error('bulkUpdate requires at least one condition');
    }

    // sql.js has no affected-rows API on `.run`, so bracket with COUNT(*).
    const before = this.conditionalCount(realTable, whereSql, whereValues);
    this.db.run(
      `UPDATE ${realTable} SET ${setClauses.join(', ')} WHERE ${whereSql}`,
      [...setValues, ...whereValues],
    );
    // After-count under the same conditions tells us how many rows still
    // match — but we want how many were *updated*, which (for matching
    // conditions that don't themselves change) is the original match count.
    return { updated: before };
  }

  /** Expose the episodes table name so tests can introspect schema. */
  static readonly EPISODES_TABLE = EPISODES_TABLE;

  // ----- private -----

  private resolveTable(logicalName: string): string {
    if (!ALLOWED_TABLES.has(logicalName)) {
      throw new Error(`BatchOperations: table '${logicalName}' is not whitelisted`);
    }
    return EPISODES_TABLE;
  }

  private tableCount(table: string): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
    try {
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  private conditionalCount(table: string, whereSql: string, values: unknown[]): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`);
    try {
      if (typeof stmt.bind === 'function') stmt.bind(values);
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  private ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${EPISODES_TABLE} (
        id TEXT PRIMARY KEY,
        key TEXT,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding BLOB,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${EPISODES_TABLE}_key ON ${EPISODES_TABLE}(key);
      CREATE INDEX IF NOT EXISTS idx_${EPISODES_TABLE}_ts ON ${EPISODES_TABLE}(ts);`,
    );
  }
}

function generateId(): string {
  return `ep-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function serializeEmbedding(embedding: EpisodeInput['embedding']): Uint8Array | null {
  if (!embedding) return null;
  const arr = embedding instanceof Float32Array
    ? embedding
    : Float32Array.from(embedding as number[]);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function buildWhere(conditions: Record<string, unknown>): { whereSql: string; values: unknown[] } {
  if (!conditions || typeof conditions !== 'object') return { whereSql: '', values: [] };
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [col, val] of Object.entries(conditions)) {
    if (!isSafeIdent(col)) {
      throw new Error(`Unsafe column identifier in conditions: '${col}'`);
    }
    if (val === null || val === undefined) {
      parts.push(`${col} IS NULL`);
    } else {
      parts.push(`${col} = ?`);
      values.push(normalizeValue(val));
    }
  }
  return { whereSql: parts.join(' AND '), values };
}

function isSafeIdent(ident: string): boolean {
  return typeof ident === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ident);
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export default BatchOperations;
