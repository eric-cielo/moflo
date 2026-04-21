/**
 * Skills — moflo-owned skill library (epic #464 Phase C3).
 *
 * Replaces `agentdb.SkillLibrary`. Stores reusable skills (name,
 * description, code, embedding) backed by sql.js with vector search
 * over cosine similarity.
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   - promote(pattern, quality)   // promote a high-quality pattern to a skill
 *
 * Full API:
 *   - addSkill({ name, description, code?, metadata? })  → id
 *   - promote(pattern, quality)                          → { skillId, promoted }
 *   - search(query, k?)                                  → top-k by cosine
 *   - getSkill(id)
 *   - deleteSkill(id)
 *   - count()
 */

import {
  deserializeEmbedding,
  embedWithFallback,
  generateId,
  parseJsonSafe,
  serializeEmbedding,
  vectorSearchRows,
  type Embedder,
} from './_shared.js';
import type { SqlJsDatabaseLike } from './types.js';

const TABLE = 'moflo_skills';
const PROMOTE_THRESHOLD = 0.8;

export interface SkillInput {
  name: string;
  description: string;
  code?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  code: string;
  quality: number;
  uses: number;
  metadata: Record<string, unknown>;
  embedding: Float32Array | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkillSearchResult extends SkillRow {
  score: number;
}

export interface PromoteResult {
  skillId: string | null;
  promoted: boolean;
  reason?: string;
}

export interface SkillsOptions {
  embedder?: Embedder;
  dimension?: number;
  /** Minimum quality to accept a `promote()` call (default 0.8). */
  promoteThreshold?: number;
}

export class Skills {
  private db: SqlJsDatabaseLike;
  private embedder?: Embedder;
  private dimension: number;
  private promoteThreshold: number;

  constructor(db: SqlJsDatabaseLike, options: SkillsOptions = {}) {
    if (!db) throw new Error('Skills requires a sql.js Database');
    this.db = db;
    this.embedder = options.embedder;
    this.dimension = options.dimension ?? 384;
    this.promoteThreshold =
      typeof options.promoteThreshold === 'number' ? options.promoteThreshold : PROMOTE_THRESHOLD;
    this.ensureSchema();
  }

  async initializeDatabase(): Promise<void> {
    this.ensureSchema();
  }

  async addSkill(input: SkillInput): Promise<string> {
    if (!input?.name || typeof input.name !== 'string') {
      throw new Error('addSkill requires a non-empty `name`');
    }
    const id = generateId('skill');
    const now = Date.now();
    const description = String(input.description ?? '');
    const code = String(input.code ?? '');
    const text = `${input.name}\n${description}\n${code}`;
    const embedding = await embedWithFallback(this.embedder, text, this.dimension);
    const blob = serializeEmbedding(embedding);
    this.db.run(
      `INSERT INTO ${TABLE}
         (id, name, description, code, quality, uses, metadata, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, input.name, description, code, 1.0, JSON.stringify(input.metadata ?? {}), blob, now, now],
    );
    return id;
  }

  /**
   * Promote a pattern to a skill if its quality clears the threshold.
   * Matches the bridge's expectation: idempotent on duplicate names.
   */
  async promote(pattern: unknown, quality: number): Promise<PromoteResult> {
    const q = typeof quality === 'number' ? quality : 0;
    if (q < this.promoteThreshold) {
      return { skillId: null, promoted: false, reason: 'below_threshold' };
    }
    const normalized = normalizePattern(pattern);
    if (!normalized) {
      return { skillId: null, promoted: false, reason: 'unparseable_pattern' };
    }

    // De-dup on name: if a skill with the same name exists, bump `uses` +
    // quality instead of creating a new row.
    const existing = this.findByName(normalized.name);
    if (existing) {
      this.db.run(
        `UPDATE ${TABLE}
           SET uses = uses + 1,
               quality = CASE WHEN ? > quality THEN ? ELSE quality END,
               updated_at = ?
         WHERE id = ?`,
        [q, q, Date.now(), existing.id],
      );
      return { skillId: existing.id, promoted: true, reason: 'updated_existing' };
    }

    const id = await this.addSkill({
      name: normalized.name,
      description: normalized.description,
      code: normalized.code,
      metadata: normalized.metadata,
    });
    this.db.run(`UPDATE ${TABLE} SET quality = ? WHERE id = ?`, [q, id]);
    return { skillId: id, promoted: true };
  }

  async search(query: string, k: number = 10): Promise<SkillSearchResult[]> {
    return vectorSearchRows(
      this.loadAll(),
      query,
      k,
      this.embedder,
      this.dimension,
      (r) => `${r.name} ${r.description} ${r.code}`,
    );
  }

  getSkill(id: string): SkillRow | null {
    const stmt = this.db.prepare(
      `SELECT id, name, description, code, quality, uses, metadata, embedding, created_at, updated_at
       FROM ${TABLE} WHERE id = ?`,
    );
    try {
      if (typeof stmt.bind === 'function') stmt.bind([id]);
      if (!stmt.step()) return null;
      return rowToSkill(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  deleteSkill(id: string): boolean {
    this.db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    return (this.db.getRowsModified?.() ?? 0) > 0;
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

  // Admin: return all skills (newest first). Used by nightly learner and tests.
  list(limit: number = 100): SkillRow[] {
    const safeLimit = Math.max(1, Math.min(limit, 10_000));
    const stmt = this.db.prepare(
      `SELECT id, name, description, code, quality, uses, metadata, embedding, created_at, updated_at
       FROM ${TABLE}
       ORDER BY created_at DESC
       LIMIT ${safeLimit}`,
    );
    const out: SkillRow[] = [];
    try {
      while (stmt.step()) out.push(rowToSkill(stmt.getAsObject()));
    } finally {
      stmt.free();
    }
    return out;
  }

  static readonly TABLE = TABLE;

  // ----- private -----

  private findByName(name: string): { id: string } | null {
    const stmt = this.db.prepare(`SELECT id FROM ${TABLE} WHERE name = ? LIMIT 1`);
    try {
      if (typeof stmt.bind === 'function') stmt.bind([name]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject();
      return row?.id ? { id: String(row.id) } : null;
    } finally {
      stmt.free();
    }
  }

  private loadAll(): SkillRow[] {
    const stmt = this.db.prepare(
      `SELECT id, name, description, code, quality, uses, metadata, embedding, created_at, updated_at
       FROM ${TABLE}`,
    );
    const rows: SkillRow[] = [];
    try {
      while (stmt.step()) rows.push(rowToSkill(stmt.getAsObject()));
    } finally {
      stmt.free();
    }
    return rows;
  }

  private ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        code TEXT NOT NULL DEFAULT '',
        quality REAL NOT NULL DEFAULT 1.0,
        uses INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_name ON ${TABLE}(name);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_created ON ${TABLE}(created_at);`,
    );
  }
}

function normalizePattern(pattern: unknown): {
  name: string;
  description: string;
  code: string;
  metadata: Record<string, unknown>;
} | null {
  if (pattern == null) return null;
  if (typeof pattern === 'string') {
    const name = pattern.slice(0, 120) || 'skill';
    return { name, description: pattern, code: '', metadata: {} };
  }
  if (typeof pattern === 'object') {
    const p = pattern as Record<string, any>;
    const rawName =
      (typeof p.name === 'string' && p.name)
      || (typeof p.title === 'string' && p.title)
      || (typeof p.key === 'string' && p.key)
      || (typeof p.pattern === 'string' && p.pattern.slice(0, 120))
      || '';
    if (!rawName) return null;
    return {
      name: String(rawName).slice(0, 256),
      description:
        (typeof p.description === 'string' && p.description)
        || (typeof p.summary === 'string' && p.summary)
        || (typeof p.pattern === 'string' && p.pattern)
        || '',
      code: typeof p.code === 'string' ? p.code : (typeof p.solution === 'string' ? p.solution : ''),
      metadata: { ...p.metadata, source: 'promote' },
    };
  }
  return null;
}

function rowToSkill(r: Record<string, any>): SkillRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    description: String(r.description ?? ''),
    code: String(r.code ?? ''),
    quality: Number(r.quality ?? 0),
    uses: Number(r.uses ?? 0),
    metadata: parseJsonSafe(r.metadata),
    embedding: deserializeEmbedding(r.embedding),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export default Skills;
