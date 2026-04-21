/**
 * HierarchicalMemory — moflo-owned tiered memory (epic #464 Phase C3).
 *
 * Replaces `agentdb.HierarchicalMemory` and supersedes the in-process
 * `createTieredMemoryStub()` previously used as a fallback.
 *
 * Tiers model a rough memory taxonomy:
 *   working        — hot, short-lived, LRU-evicted by capacity
 *   episodic       — session-scoped events, time-decayed
 *   semantic       — long-term distilled facts, survives eviction
 *   metaCognitive  — "how we think" — strategies, preferences
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   store(content, importance, tier, { metadata, tags }) → id
 *   recall({ query, tier?, k?, threshold? })            → MemoryItem[]
 *   getStats()                                          → Record<tier, n>
 *   promote(id, fromTier, toTier)                       → boolean
 *
 * `HierarchicalMemoryStub` shadows the same public shape (including
 * listTier/transaction/initializeDatabase) so callers can invoke the API
 * unconditionally without duck-type probes when sql.js is unavailable.
 * Downstream controllers should accept the `HierarchicalMemoryLike` alias
 * exported below rather than the concrete class.
 */

import {
  deserializeEmbedding,
  embedWithFallback,
  generateId,
  parseJsonSafe,
  rankByVector,
  serializeEmbedding,
  type Embedder,
} from './_shared.js';
import type { SqlJsDatabaseLike } from './types.js';
import type { ControllerSpec } from '../controller-spec.js';

const TABLE = 'moflo_hierarchical_memory';

export type Tier = 'working' | 'episodic' | 'semantic' | 'metaCognitive';
const TIERS: Tier[] = ['working', 'episodic', 'semantic', 'metaCognitive'];
const DEFAULT_CAPACITY: Record<Tier, number> = {
  working: 500,
  episodic: 5000,
  semantic: 20_000,
  metaCognitive: 2000,
};

export interface HierarchicalStoreOptions {
  metadata?: Record<string, unknown>;
  tags?: string[];
  key?: string;
}

export interface MemoryQuery {
  query: string;
  tier?: Tier | string;
  k?: number;
  threshold?: number;
  context?: string;
}

export interface MemoryItem {
  id: string;
  key: string;
  tier: Tier;
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  tags: string[];
  score: number;
  timestamp: number;
  accessCount: number;
}

interface InternalRow extends MemoryItem {
  embedding: Float32Array | null;
}

export interface HierarchicalMemoryOptions {
  embedder?: Embedder;
  dimension?: number;
  capacities?: Partial<Record<Tier, number>>;
}

export class HierarchicalMemory {
  private db: SqlJsDatabaseLike;
  private embedder?: Embedder;
  private dimension: number;
  private capacities: Record<Tier, number>;

  constructor(db: SqlJsDatabaseLike, options: HierarchicalMemoryOptions = {}) {
    if (!db) throw new Error('HierarchicalMemory requires a sql.js Database');
    this.db = db;
    this.embedder = options.embedder;
    this.dimension = options.dimension ?? 384;
    this.capacities = { ...DEFAULT_CAPACITY, ...(options.capacities ?? {}) };
    this.ensureSchema();
  }

  async initializeDatabase(): Promise<void> {
    this.ensureSchema();
  }

  async store(
    content: string,
    importance: number = 0.5,
    tier: Tier | string = 'working',
    options: HierarchicalStoreOptions = {},
  ): Promise<string> {
    const tierName = coerceTier(tier);
    const id = generateId('hm');
    const now = Date.now();
    const keyMeta = typeof options.metadata?.key === 'string' ? (options.metadata.key as string) : undefined;
    const key = options.key ?? keyMeta ?? id;
    const embedding = await embedWithFallback(this.embedder, String(content ?? ''), this.dimension);
    const blob = serializeEmbedding(embedding);
    const metaJson = JSON.stringify(options.metadata ?? {});
    const tagsJson = JSON.stringify(options.tags ?? []);
    const clampedImportance = clamp(importance, 0, 1);
    this.db.run(
      `INSERT INTO ${TABLE}
         (id, key, tier, content, importance, metadata, tags, embedding, created_at, accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [id, key, tierName, String(content ?? ''), clampedImportance, metaJson, tagsJson, blob, now, now],
    );
    this.enforceCapacity(tierName);
    return id;
  }

  async recall(query: MemoryQuery | string, legacyK?: number): Promise<MemoryItem[]> {
    // Backwards-compat: the stub API was recall(string, number). Support it.
    if (typeof query === 'string') {
      return this.recall({ query, k: typeof legacyK === 'number' ? legacyK : 10 });
    }
    if (!query || typeof query.query !== 'string') return [];
    const k = Math.max(1, Math.min(query.k ?? 10, 1000));
    const tier = query.tier ? coerceTier(query.tier) : null;
    const threshold = typeof query.threshold === 'number' ? query.threshold : 0;
    const rows = this.loadByTier(tier);
    if (rows.length === 0) return [];
    const queryVec = await embedWithFallback(this.embedder, query.query, this.dimension);
    const ranked = rankByVector(rows, queryVec, query.query, k)
      .filter((r) => r.score >= threshold)
      .slice(0, k);

    // Side effect: bump access counts so promote() / eviction can use them.
    this.bumpAccessCounts(ranked.map((r) => r.id));

    return ranked.map(({ embedding: _embedding, ...rest }) => ({
      ...rest,
      accessCount: rest.accessCount + 1,
    }));
  }

  async promote(id: string, _fromTier: Tier | string, toTier: Tier | string): Promise<boolean> {
    const target = coerceTier(toTier);
    this.db.run(
      `UPDATE ${TABLE} SET tier = ?, accessed_at = ? WHERE id = ?`,
      [target, Date.now(), id],
    );
    if ((this.db.getRowsModified?.() ?? 0) === 0) return false;
    this.enforceCapacity(target);
    return true;
  }

  async forget(id: string): Promise<boolean> {
    this.db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    return (this.db.getRowsModified?.() ?? 0) > 0;
  }

  /**
   * Execute `fn` inside a BEGIN/COMMIT on the same db. Used by
   * MemoryConsolidation to batch many promote/forget calls into one
   * transaction. Rolls back on exception and rethrows.
   */
  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    this.db.run('BEGIN TRANSACTION');
    return Promise.resolve()
      .then(() => fn())
      .then(
        (result) => {
          this.db.run('COMMIT');
          return result;
        },
        (err) => {
          this.db.run('ROLLBACK');
          throw err;
        },
      );
  }

  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const tier of TIERS) stats[tier] = this.countTier(tier);
    stats.total = TIERS.reduce((acc, t) => acc + stats[t], 0);
    return stats;
  }

  count(tier?: Tier | string): number {
    if (tier) return this.countTier(coerceTier(tier));
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    try {
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  /**
   * Enumerate rows in a tier ordered oldest-first. Used by
   * MemoryConsolidation to walk episodic candidates for promotion.
   */
  listTier(tier: Tier | string, limit: number = 1000): MemoryItem[] {
    const t = coerceTier(tier);
    const safeLimit = Math.max(1, Math.min(limit, 100_000));
    const stmt = this.db.prepare(
      `SELECT id, key, tier, content, importance, metadata, tags, embedding, created_at, access_count
       FROM ${TABLE}
       WHERE tier = ?
       ORDER BY created_at ASC
       LIMIT ${safeLimit}`,
    );
    const out: MemoryItem[] = [];
    try {
      if (typeof stmt.bind === 'function') stmt.bind([t]);
      while (stmt.step()) {
        const { embedding: _e, ...rest } = rowToItem(stmt.getAsObject());
        out.push(rest);
      }
    } finally {
      stmt.free();
    }
    return out;
  }

  static readonly TABLE = TABLE;

  // ----- private -----

  private loadByTier(tier: Tier | null): InternalRow[] {
    const sql = tier
      ? `SELECT id, key, tier, content, importance, metadata, tags, embedding, created_at, access_count
         FROM ${TABLE} WHERE tier = ?`
      : `SELECT id, key, tier, content, importance, metadata, tags, embedding, created_at, access_count
         FROM ${TABLE}`;
    const stmt = this.db.prepare(sql);
    const rows: InternalRow[] = [];
    try {
      if (tier && typeof stmt.bind === 'function') stmt.bind([tier]);
      while (stmt.step()) rows.push(rowToItem(stmt.getAsObject()));
    } finally {
      stmt.free();
    }
    return rows;
  }

  private bumpAccessCounts(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const id of ids) {
        this.db.run(
          `UPDATE ${TABLE} SET access_count = access_count + 1, accessed_at = ? WHERE id = ?`,
          [now, id],
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  private countTier(tier: Tier): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE tier = ?`);
    try {
      if (typeof stmt.bind === 'function') stmt.bind([tier]);
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  private enforceCapacity(tier: Tier): void {
    const cap = this.capacities[tier];
    if (!cap || cap <= 0) return;
    const excess = this.countTier(tier) - cap;
    if (excess <= 0) return;
    // Evict lowest importance first, then oldest.
    this.db.run(
      `DELETE FROM ${TABLE}
       WHERE id IN (
         SELECT id FROM ${TABLE}
          WHERE tier = ?
          ORDER BY importance ASC, accessed_at ASC
          LIMIT ${excess}
       )`,
      [tier],
    );
  }

  private ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        tier TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        metadata TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        embedding BLOB,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_tier ON ${TABLE}(tier);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_created ON ${TABLE}(created_at);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_key ON ${TABLE}(key);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_eviction ON ${TABLE}(tier, importance, accessed_at);`,
    );
  }
}

function coerceTier(tier: Tier | string): Tier {
  const t = String(tier);
  return (TIERS as string[]).includes(t) ? (t as Tier) : 'working';
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function stubRowToItem(row: InternalStubRow, score: number): MemoryItem {
  return {
    id: row.id,
    key: row.key,
    tier: row.tier,
    content: row.content,
    importance: row.importance,
    metadata: row.metadata,
    tags: row.tags,
    score,
    timestamp: row.timestamp,
    accessCount: row.accessCount,
  };
}

function rowToItem(r: Record<string, any>): InternalRow {
  return {
    id: String(r.id),
    key: String(r.key ?? r.id),
    tier: coerceTier(String(r.tier ?? 'working')),
    content: String(r.content ?? ''),
    importance: Number(r.importance ?? 0.5),
    metadata: parseJsonSafe(r.metadata),
    tags: parseTags(r.tags),
    embedding: deserializeEmbedding(r.embedding),
    score: 0,
    timestamp: Number(r.created_at ?? 0),
    accessCount: Number(r.access_count ?? 0),
  };
}

/**
 * In-memory fallback used when sql.js is unavailable. Mirrors the public
 * surface of {@link HierarchicalMemory} so callers can invoke the API
 * unconditionally — no duck-type probes.
 */
export class HierarchicalMemoryStub {
  private static readonly MAX_PER_TIER = 5000;
  private readonly tiers = new Map<Tier, Map<string, InternalStubRow>>();

  constructor() {
    for (const tier of TIERS) this.tiers.set(tier, new Map());
  }

  async store(
    content: string,
    importance: number = 0.5,
    tier: Tier | string = 'working',
    options: HierarchicalStoreOptions = {},
  ): Promise<string> {
    const tierName = coerceTier(tier);
    const id = generateId('hm-stub');
    const keyMeta = typeof options.metadata?.key === 'string' ? (options.metadata.key as string) : undefined;
    const key = options.key ?? keyMeta ?? id;
    const row: InternalStubRow = {
      id,
      key,
      tier: tierName,
      content: String(content ?? '').substring(0, 100_000),
      importance: clamp(importance, 0, 1),
      metadata: options.metadata ?? {},
      tags: options.tags ?? [],
      timestamp: Date.now(),
      accessCount: 0,
    };
    const bucket = this.tiers.get(tierName)!;
    if (bucket.size >= HierarchicalMemoryStub.MAX_PER_TIER) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) bucket.delete(oldest);
    }
    bucket.set(id, row);
    return id;
  }

  async recall(query: MemoryQuery | string, legacyK?: number): Promise<MemoryItem[]> {
    if (typeof query === 'string') {
      return this.recall({ query, k: typeof legacyK === 'number' ? legacyK : 10 });
    }
    if (!query || typeof query.query !== 'string') return [];
    const k = Math.max(1, Math.min(query.k ?? 10, 1000));
    const tierFilter = query.tier ? coerceTier(query.tier) : null;
    const q = query.query.toLowerCase().substring(0, 10_000);

    const matches: MemoryItem[] = [];
    for (const [tierName, bucket] of this.tiers) {
      if (tierFilter && tierName !== tierFilter) continue;
      for (const row of bucket.values()) {
        if (row.key.toLowerCase().includes(q) || row.content.toLowerCase().includes(q)) {
          row.accessCount += 1;
          matches.push(stubRowToItem(row, 1));
        }
      }
    }
    return matches.sort((a, b) => b.timestamp - a.timestamp).slice(0, k);
  }

  async promote(id: string, _fromTier: Tier | string, toTier: Tier | string): Promise<boolean> {
    const target = coerceTier(toTier);
    for (const [tierName, bucket] of this.tiers) {
      const row = bucket.get(id);
      if (!row) continue;
      if (tierName === target) return true;
      bucket.delete(id);
      row.tier = target;
      this.tiers.get(target)!.set(id, row);
      return true;
    }
    return false;
  }

  async forget(id: string): Promise<boolean> {
    for (const bucket of this.tiers.values()) {
      if (bucket.delete(id)) return true;
    }
    return false;
  }

  async initializeDatabase(): Promise<void> {
    // In-memory stub has no schema to create.
  }

  listTier(tier: Tier | string, limit: number = 1000): MemoryItem[] {
    const t = coerceTier(tier);
    const bucket = this.tiers.get(t);
    if (!bucket) return [];
    const safeLimit = Math.max(1, Math.min(limit, 100_000));
    const out: MemoryItem[] = [];
    for (const row of bucket.values()) out.push(stubRowToItem(row, 0));
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out.slice(0, safeLimit);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    // Stub has no durable state — a thrown error propagates but any
    // in-memory writes made by fn are NOT rolled back (the real class
    // emits SQL ROLLBACK; we have nothing to revert against).
    return Promise.resolve().then(() => fn());
  }

  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    let total = 0;
    for (const tier of TIERS) {
      const n = this.tiers.get(tier)?.size ?? 0;
      stats[tier] = n;
      total += n;
    }
    stats.total = total;
    return stats;
  }

  count(tier?: Tier | string): number {
    if (tier) return this.tiers.get(coerceTier(tier))?.size ?? 0;
    let total = 0;
    for (const bucket of this.tiers.values()) total += bucket.size;
    return total;
  }
}

interface InternalStubRow {
  id: string;
  key: string;
  tier: Tier;
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  tags: string[];
  timestamp: number;
  accessCount: number;
}

/**
 * Shared surface between {@link HierarchicalMemory} and
 * {@link HierarchicalMemoryStub}. Use this where a caller must work with
 * either implementation (e.g. MemoryConsolidation).
 */
export type HierarchicalMemoryLike = HierarchicalMemory | HierarchicalMemoryStub;

/**
 * Method names that MUST exist on both HierarchicalMemory and
 * HierarchicalMemoryStub (issue #493 — stub parity). Tests iterate this
 * to verify no duck-typing is needed on the consumer side.
 */
export const HIERARCHICAL_MEMORY_SURFACE = [
  'store',
  'recall',
  'promote',
  'forget',
  'getStats',
  'count',
  'listTier',
  'transaction',
  'initializeDatabase',
] as const;

export const hierarchicalMemorySpec: ControllerSpec = {
  name: 'hierarchicalMemory',
  level: 1,
  enabledByDefault: true,
  create: async ({ mofloDb, embedder }) => {
    if (!mofloDb?.database) return new HierarchicalMemoryStub();
    const hm = new HierarchicalMemory(mofloDb.database, { embedder });
    await hm.initializeDatabase();
    return hm;
  },
};

export default HierarchicalMemory;
