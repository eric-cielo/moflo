/**
 * Reflexion — moflo-owned failure-memory / session-replay controller (epic #464 Phase C3).
 *
 * Replaces `agentdb.ReflexionMemory`. Implements the Reflexion pattern
 * (Shinn et al. 2023): after a task, record (action, outcome, reflection)
 * so future tasks can recall useful corrections via vector similarity.
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   - startEpisode(sessionId, { context })
 *   - endEpisode(sessionId, { summary, tasksCompleted, patternsLearned })
 *
 * Full API (beyond the bridge's use):
 *   - addReflection({ action, outcome, reflection, metadata? })  → id
 *   - search(query, k?)   → top-k by cosine over stored embeddings
 *   - listEpisodes(limit?)
 *   - count()
 */

import {
  clampInt,
  deserializeEmbedding,
  embedText,
  generateId,
  parseJsonSafe,
  serializeEmbedding,
  vectorSearchRows,
  type Embedder,
} from './_shared.js';
import type { SqlJsDatabaseLike } from './types.js';
import type { ControllerSpec } from '../controller-spec.js';

const REFLEXIONS_TABLE = 'moflo_reflexions';
const EPISODES_TABLE = 'moflo_reflexion_episodes';

export interface ReflexionInput {
  action: string;
  outcome: string;
  reflection: string;
  metadata?: Record<string, unknown>;
}

export interface ReflexionRow {
  id: string;
  timestamp: number;
  action: string;
  outcome: string;
  reflection: string;
  metadata: Record<string, unknown>;
  embedding: Float32Array | null;
}

export interface ReflexionSearchResult extends ReflexionRow {
  score: number;
}

export interface EpisodeRow {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  context: string;
  summary: string;
  tasksCompleted: number;
  patternsLearned: number;
}

export interface ReflexionOptions {
  embedder?: Embedder;
  dimension?: number;
}

export class Reflexion {
  private db: SqlJsDatabaseLike;
  private embedder?: Embedder;
  private dimension: number;

  constructor(db: SqlJsDatabaseLike, options: ReflexionOptions = {}) {
    if (!db) throw new Error('Reflexion requires a sql.js Database');
    this.db = db;
    this.embedder = options.embedder;
    this.dimension = options.dimension ?? 384;
    this.ensureSchema();
  }

  /**
   * API-compatibility shim: agentdb's HierarchicalMemory/MemoryConsolidation
   * expose `initializeDatabase`. Providing the same hook here lets
   * controller-registry treat our impl uniformly.
   */
  async initializeDatabase(): Promise<void> {
    this.ensureSchema();
  }

  async addReflection(input: ReflexionInput): Promise<string> {
    const id = generateId('rfx');
    const ts = Date.now();
    const text = `${input.action}\n${input.outcome}\n${input.reflection}`;
    const embedding = await embedText(this.embedder, text);
    const blob = serializeEmbedding(embedding);
    this.db.run(
      `INSERT INTO ${REFLEXIONS_TABLE}
         (id, ts, action, outcome, reflection, metadata, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, ts, input.action, input.outcome, input.reflection, JSON.stringify(input.metadata ?? {}), blob],
    );
    return id;
  }

  async search(query: string, k: number = 10): Promise<ReflexionSearchResult[]> {
    return vectorSearchRows(
      this.loadAll(),
      query,
      k,
      this.embedder,
      (r) => `${r.action} ${r.outcome} ${r.reflection}`,
    );
  }

  async startEpisode(sessionId: string, options: { context?: string } = {}): Promise<void> {
    if (!sessionId) throw new Error('startEpisode requires sessionId');
    const now = Date.now();
    this.db.run(
      `INSERT OR REPLACE INTO ${EPISODES_TABLE}
         (session_id, started_at, ended_at, context, summary, tasks_completed, patterns_learned)
       VALUES (?, ?, NULL, ?, '', 0, 0)`,
      [sessionId, now, options.context ?? ''],
    );
  }

  async endEpisode(
    sessionId: string,
    summary: { summary?: string; tasksCompleted?: number; patternsLearned?: number } = {},
  ): Promise<void> {
    if (!sessionId) throw new Error('endEpisode requires sessionId');
    const now = Date.now();
    // Try UPDATE first; if nothing matched, startEpisode was skipped — INSERT.
    // Avoids a full SELECT + hydrate just to test existence.
    this.db.run(
      `UPDATE ${EPISODES_TABLE}
         SET ended_at = ?, summary = ?, tasks_completed = ?, patterns_learned = ?
       WHERE session_id = ?`,
      [
        now,
        summary.summary ?? '',
        summary.tasksCompleted ?? 0,
        summary.patternsLearned ?? 0,
        sessionId,
      ],
    );
    if (this.db.getRowsModified?.() ?? 0) return;
    this.db.run(
      `INSERT INTO ${EPISODES_TABLE}
         (session_id, started_at, ended_at, context, summary, tasks_completed, patterns_learned)
       VALUES (?, ?, ?, '', ?, ?, ?)`,
      [
        sessionId,
        now,
        now,
        summary.summary ?? '',
        summary.tasksCompleted ?? 0,
        summary.patternsLearned ?? 0,
      ],
    );
  }

  getEpisode(sessionId: string): EpisodeRow | null {
    const stmt = this.db.prepare(
      `SELECT session_id, started_at, ended_at, context, summary, tasks_completed, patterns_learned
       FROM ${EPISODES_TABLE} WHERE session_id = ?`,
    );
    try {
      if (typeof stmt.bind === 'function') stmt.bind([sessionId]);
      if (!stmt.step()) return null;
      return rowToEpisode(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  listEpisodes(limit: number = 100): EpisodeRow[] {
    const safeLimit = clampInt(limit, 1, 10_000, 100);
    const stmt = this.db.prepare(
      `SELECT session_id, started_at, ended_at, context, summary, tasks_completed, patterns_learned
       FROM ${EPISODES_TABLE}
       ORDER BY started_at DESC
       LIMIT ${safeLimit}`,
    );
    const out: EpisodeRow[] = [];
    try {
      while (stmt.step()) out.push(rowToEpisode(stmt.getAsObject()));
    } finally {
      stmt.free();
    }
    return out;
  }

  count(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${REFLEXIONS_TABLE}`);
    try {
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  episodeCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${EPISODES_TABLE}`);
    try {
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  // Exposed only for benchmark/test harnesses; not part of the public surface.
  static readonly REFLEXIONS_TABLE = REFLEXIONS_TABLE;
  static readonly EPISODES_TABLE = EPISODES_TABLE;

  // ----- private -----

  private loadAll(): ReflexionRow[] {
    const stmt = this.db.prepare(
      `SELECT id, ts, action, outcome, reflection, metadata, embedding
       FROM ${REFLEXIONS_TABLE}`,
    );
    const rows: ReflexionRow[] = [];
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        rows.push({
          id: String(r.id),
          timestamp: Number(r.ts),
          action: String(r.action ?? ''),
          outcome: String(r.outcome ?? ''),
          reflection: String(r.reflection ?? ''),
          metadata: parseJsonSafe(r.metadata),
          embedding: deserializeEmbedding(r.embedding),
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${REFLEXIONS_TABLE} (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reflection TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_${REFLEXIONS_TABLE}_ts ON ${REFLEXIONS_TABLE}(ts);

      CREATE TABLE IF NOT EXISTS ${EPISODES_TABLE} (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        context TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        tasks_completed INTEGER NOT NULL DEFAULT 0,
        patterns_learned INTEGER NOT NULL DEFAULT 0
      );`,
    );
  }
}

function rowToEpisode(r: Record<string, any>): EpisodeRow {
  return {
    sessionId: String(r.session_id),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    context: String(r.context ?? ''),
    summary: String(r.summary ?? ''),
    tasksCompleted: Number(r.tasks_completed ?? 0),
    patternsLearned: Number(r.patterns_learned ?? 0),
  };
}

export const reflexionSpec: ControllerSpec = {
  name: 'reflexion',
  level: 3,
  requires: ['sqljs'],
  enabledByDefault: true,
  create: async ({ mofloDb, embedder }) => {
    const reflexion = new Reflexion(mofloDb!.database, { embedder });
    await reflexion.initializeDatabase();
    return reflexion;
  },
};

export default Reflexion;
