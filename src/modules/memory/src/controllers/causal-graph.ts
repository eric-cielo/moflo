/**
 * CausalGraph — moflo-owned causal edge store.
 *
 * Replaces `agentdb.CausalGraph.addEdge`. Stores typed edges between
 * memory-entry IDs in a sql.js-backed table with composite indexes so
 * CausalRecall's BFS walks don't hit a full scan on the relation filter.
 */

import { clamp01, clampInt, parseJsonSafe } from './_shared.js';
import type { SqlJsDatabaseLike } from './types.js';

const TABLE = 'moflo_causal_edges';

export interface CausalEdgeInput {
  relation: string;
  weight?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface CausalEdge {
  id: number;
  source: string;
  target: string;
  relation: string;
  weight: number;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export interface NeighborOptions {
  direction?: 'out' | 'in' | 'both';
  relation?: string;
  limit?: number;
}

export interface EdgeQuery {
  source?: string;
  target?: string;
  relation?: string;
  limit?: number;
}

export class CausalGraph {
  static TABLE = TABLE;

  private db: SqlJsDatabaseLike;

  constructor(db: SqlJsDatabaseLike) {
    if (!db) throw new Error('CausalGraph requires a sql.js Database');
    this.db = db;
    this.ensureSchema();
  }

  async initializeDatabase(): Promise<void> {
    this.ensureSchema();
  }

  addEdge(source: string, target: string, input: CausalEdgeInput): void {
    if (!source || !target) throw new Error('addEdge requires source and target ids');
    if (!input?.relation) throw new Error('addEdge requires a relation');
    const weight = typeof input.weight === 'number' && Number.isFinite(input.weight)
      ? clamp01(input.weight)
      : 1.0;
    const ts = typeof input.timestamp === 'number' ? input.timestamp : Date.now();
    const metaJson = JSON.stringify(input.metadata ?? {});
    this.db.run(
      `INSERT OR REPLACE INTO ${TABLE} (source, target, relation, weight, ts, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(source), String(target), String(input.relation), weight, ts, metaJson],
    );
  }

  neighbors(id: string, options: NeighborOptions = {}): CausalEdge[] {
    if (!id) return [];
    const direction = options.direction ?? 'out';
    const limit = clampInt(options.limit, 1, 500, 500);
    const where: string[] = [];
    const params: any[] = [];
    if (direction === 'out') {
      where.push('source = ?');
      params.push(id);
    } else if (direction === 'in') {
      where.push('target = ?');
      params.push(id);
    } else {
      where.push('(source = ? OR target = ?)');
      params.push(id, id);
    }
    if (options.relation) {
      where.push('relation = ?');
      params.push(options.relation);
    }
    const sql = `SELECT id, source, target, relation, weight, ts, metadata
      FROM ${TABLE}
      WHERE ${where.join(' AND ')}
      ORDER BY weight DESC, ts DESC
      LIMIT ${limit}`;
    return this.query(sql, params);
  }

  edges(options: EdgeQuery = {}): CausalEdge[] {
    const limit = clampInt(options.limit, 1, 1000, 1000);
    const where: string[] = [];
    const params: any[] = [];
    if (options.source) { where.push('source = ?'); params.push(options.source); }
    if (options.target) { where.push('target = ?'); params.push(options.target); }
    if (options.relation) { where.push('relation = ?'); params.push(options.relation); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT id, source, target, relation, weight, ts, metadata
      FROM ${TABLE} ${filter} ORDER BY id ASC LIMIT ${limit}`;
    return this.query(sql, params);
  }

  count(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    try {
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  clear(): void {
    this.db.run(`DELETE FROM ${TABLE}`);
  }

  private query(sql: string, params: any[]): CausalEdge[] {
    const stmt = this.db.prepare(sql);
    const out: CausalEdge[] = [];
    try {
      if (typeof stmt.bind === 'function') stmt.bind(params);
      while (stmt.step()) {
        out.push(rowToEdge(stmt.getAsObject()));
      }
    } finally {
      stmt.free();
    }
    return out;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL,
        ts INTEGER NOT NULL,
        metadata TEXT NOT NULL,
        UNIQUE(source, target, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_source_rel ON ${TABLE}(source, relation);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_target_rel ON ${TABLE}(target, relation);
    `);
  }
}

function rowToEdge(r: Record<string, any>): CausalEdge {
  return {
    id: Number(r.id),
    source: String(r.source),
    target: String(r.target),
    relation: String(r.relation),
    weight: Number(r.weight),
    timestamp: Number(r.ts),
    metadata: parseJsonSafe(r.metadata),
  };
}

export default CausalGraph;
