/**
 * SqliteBackend — native node:sqlite backend for moflo.db
 *
 * Drop-in replacement for {@link SqlJsBackend} (same IMemoryBackend surface,
 * same schema, same event emissions) backed by the Node 22+ built-in
 * `node:sqlite` engine instead of WASM. Phase 4 (#1083) made this the
 * default; Phase 5 (#1084) deletes the sql.js backend + npm dep.
 *
 * Why this exists: epic #1078 / Phase 0 spike (#1079, PR #1085) confirmed
 * `node:sqlite` parity against shipped sql.js DBs. The structural sql.js
 * failure mode is whole-file snapshots: each process holds its own copy and
 * the last flusher wipes the other's writes. `node:sqlite` writes through
 * the OS file handle and uses WAL for multi-process serialization, which
 * removes that failure mode entirely.
 *
 * @module v3/memory/sqlite-backend
 */

// MUST come before `import 'node:sqlite'` below — see suppress-sqlite-warning
// header for rationale (#1098).
import './suppress-sqlite-warning.js';
import { EventEmitter } from 'node:events';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { cosineSimilarity } from './hnsw-lite.js';
import {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryUpdate,
  MemoryQuery,
  SearchOptions,
  SearchResult,
  BackendStats,
  HealthCheckResult,
  ComponentHealth,
  MemoryType,
  EmbeddingGenerator,
} from './types.js';

/**
 * Configuration for {@link SqliteBackend}. Mirrors SqlJsBackendConfig so the
 * provider can swap backends without rewriting call sites.
 */
export interface SqliteBackendConfig {
  /** Path to SQLite database file (`:memory:` for in-memory) */
  databasePath: string;

  /** Enable query optimization (reserved for future use) */
  optimize: boolean;

  /** Default namespace */
  defaultNamespace: string;

  /** Embedding generator (for compatibility with hybrid mode) */
  embeddingGenerator?: EmbeddingGenerator;

  /** Maximum entries before auto-cleanup (advisory only) */
  maxEntries: number;

  /** Enable verbose logging */
  verbose: boolean;

  /**
   * Auto-persist interval — accepted for parity with SqlJsBackendConfig but a
   * no-op here. node:sqlite writes through the OS file handle; there is no
   * in-memory image that needs explicit flushing.
   */
  autoPersistInterval: number;
}

const DEFAULT_CONFIG: SqliteBackendConfig = {
  databasePath: ':memory:',
  optimize: true,
  defaultNamespace: 'default',
  maxEntries: 1000000,
  verbose: false,
  autoPersistInterval: 0,
};

type RowShape = Record<string, unknown>;

/**
 * Names of the prepared statements cached at the Database level. Keyed
 * lookup keeps {@link SqliteBackend.stmts} typed without a parallel field
 * per statement.
 */
type StmtName =
  | 'store'
  | 'getById'
  | 'getByKey'
  | 'deleteById'
  | 'updateAccess'
  | 'countAll'
  | 'countByNamespace'
  | 'countByType'
  | 'listNamespaces'
  | 'clearNamespace'
  | 'deleteByNamespace';

export class SqliteBackend extends EventEmitter implements IMemoryBackend {
  private config: SqliteBackendConfig;
  private db: DatabaseSync | null = null;
  private initialized = false;
  private stmts: Partial<Record<StmtName, StatementSync>> = {};
  private cachedPageSize = 0;

  private stats = {
    queryCount: 0,
    totalQueryTime: 0,
    writeCount: 0,
    totalWriteTime: 0,
  };

  constructor(config: Partial<SqliteBackendConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = new DatabaseSync(this.config.databasePath);
    try {
      if (this.config.databasePath !== ':memory:') {
        // WAL is required for the multi-process serialization invariant proven
        // in the Phase 0 spike. The spike verified the .db-wal/.db-shm sidecars
        // appear on first write.
        //
        // busy_timeout BEFORE journal_mode = WAL: the WAL pragma briefly takes
        // an EXCLUSIVE lock, and concurrent openers otherwise hit "database is
        // locked" with no retry budget (#1097).
        // 15000ms matches daemon-backend.ts (#1098 — the harness's first-pass
        // indexer can hold a write lock for 5–8s after npm install).
        db.exec('PRAGMA busy_timeout = 15000');
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
      }

      this.db = db;
      this.createSchema();
      this.prepareCachedStatements();
      this.cachedPageSize = this.readPageSize();
    } catch (err) {
      // Don't leak the handle if any setup step threw — a subsequent
      // initialize() retry would otherwise orphan it.
      try { db.close(); } catch { /* already closed */ }
      this.db = null;
      this.stmts = {};
      throw err;
    }

    this.initialized = true;
    this.emit('initialized');

    if (this.config.verbose) {
      console.log(`[SqliteBackend] Ready (${this.config.databasePath})`);
    }
  }

  private readPageSize(): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined;
      return Number(row?.page_size ?? 0);
    } catch {
      return 0;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || !this.db) return;

    // Finalize cached statements before closing — node:sqlite requires every
    // prepared statement to be released before db.close().
    this.stmts = {};
    this.db.close();
    this.db = null;
    this.initialized = false;
    this.emit('shutdown');
  }

  private createSchema(): void {
    if (!this.db) return;

    // Mirrors SqlJsBackend.createSchema exactly. `IF NOT EXISTS` is a no-op
    // when a pre-existing DB (e.g. one created by MEMORY_SCHEMA_V3) already
    // has the table — the schema discrepancy noted in epic #1078 Phase 0 is
    // tolerated here for drop-in parity.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        type TEXT NOT NULL,
        namespace TEXT NOT NULL,
        tags TEXT NOT NULL,
        metadata TEXT NOT NULL,
        owner_id TEXT,
        access_level TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        "references" TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_namespace ON memory_entries(namespace);
      CREATE INDEX IF NOT EXISTS idx_key ON memory_entries(key);
      CREATE INDEX IF NOT EXISTS idx_type ON memory_entries(type);
      CREATE INDEX IF NOT EXISTS idx_created_at ON memory_entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_expires_at ON memory_entries(expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_namespace_key ON memory_entries(namespace, key);
    `);
  }

  private prepareCachedStatements(): void {
    if (!this.db) return;

    this.stmts.store = this.db.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, key, content, embedding, type, namespace, tags, metadata,
        owner_id, access_level, created_at, updated_at, expires_at,
        version, "references", access_count, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmts.getById = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?');
    this.stmts.getByKey = this.db.prepare(
      'SELECT * FROM memory_entries WHERE namespace = ? AND key = ?'
    );
    this.stmts.deleteById = this.db.prepare('DELETE FROM memory_entries WHERE id = ?');
    this.stmts.updateAccess = this.db.prepare(
      'UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
    );
    this.stmts.countAll = this.db.prepare('SELECT COUNT(*) AS c FROM memory_entries');
    this.stmts.countByNamespace = this.db.prepare(
      'SELECT COUNT(*) AS c FROM memory_entries WHERE namespace = ?'
    );
    this.stmts.countByType = this.db.prepare(
      'SELECT COUNT(*) AS c FROM memory_entries WHERE type = ?'
    );
    this.stmts.listNamespaces = this.db.prepare(
      'SELECT DISTINCT namespace FROM memory_entries'
    );
    this.stmts.clearNamespace = this.db.prepare(
      'SELECT COUNT(*) AS c FROM memory_entries WHERE namespace = ?'
    );
    this.stmts.deleteByNamespace = this.db.prepare(
      'DELETE FROM memory_entries WHERE namespace = ?'
    );
  }

  async store(entry: MemoryEntry): Promise<void> {
    this.ensureInitialized();
    const t0 = performance.now();

    // Copy into a fresh Buffer rather than reusing entry.embedding.buffer —
    // the underlying ArrayBufferLike may be a SharedArrayBuffer (typing
    // mismatch with node:sqlite's Buffer expectation) and downstream code
    // shouldn't be coupled to whatever allocation backed the input.
    let embeddingBuf: Buffer | null = null;
    if (entry.embedding) {
      embeddingBuf = Buffer.alloc(entry.embedding.byteLength);
      embeddingBuf.set(new Uint8Array(
        entry.embedding.buffer.slice(
          entry.embedding.byteOffset,
          entry.embedding.byteOffset + entry.embedding.byteLength,
        ) as ArrayBuffer,
      ));
    }

    this.stmts.store!.run(
      entry.id,
      entry.key,
      entry.content,
      embeddingBuf,
      entry.type,
      entry.namespace,
      JSON.stringify(entry.tags),
      JSON.stringify(entry.metadata),
      entry.ownerId ?? null,
      entry.accessLevel,
      entry.createdAt,
      entry.updatedAt,
      entry.expiresAt ?? null,
      entry.version,
      JSON.stringify(entry.references),
      entry.accessCount,
      entry.lastAccessedAt
    );

    const duration = performance.now() - t0;
    this.stats.writeCount++;
    this.stats.totalWriteTime += duration;
    this.emit('entry:stored', { entry, duration });
  }

  async get(id: string): Promise<MemoryEntry | null> {
    this.ensureInitialized();
    const t0 = performance.now();

    const row = this.stmts.getById!.get(id) as RowShape | undefined;
    const duration = performance.now() - t0;
    this.stats.queryCount++;
    this.stats.totalQueryTime += duration;

    if (!row) return null;

    const entry = this.rowToEntry(row);
    this.updateAccessTracking(id);
    this.emit('entry:retrieved', { id, duration });
    return entry;
  }

  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    this.ensureInitialized();
    const t0 = performance.now();

    const row = this.stmts.getByKey!.get(namespace, key) as RowShape | undefined;
    const duration = performance.now() - t0;
    this.stats.queryCount++;
    this.stats.totalQueryTime += duration;

    if (!row) return null;

    const entry = this.rowToEntry(row);
    this.updateAccessTracking(entry.id);
    this.emit('entry:retrieved', { namespace, key, duration });
    return entry;
  }

  async update(id: string, updateData: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    this.ensureInitialized();
    const t0 = performance.now();

    const existing = await this.get(id);
    if (!existing) return null;

    const updated: MemoryEntry = {
      ...existing,
      ...updateData,
      updatedAt: Date.now(),
      version: existing.version + 1,
    };

    await this.store(updated);

    const duration = performance.now() - t0;
    this.emit('entry:updated', { id, update: updateData, duration });
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();
    const t0 = performance.now();

    this.stmts.deleteById!.run(id);

    const duration = performance.now() - t0;
    this.stats.writeCount++;
    this.stats.totalWriteTime += duration;
    this.emit('entry:deleted', { id, duration });
    return true;
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    this.ensureInitialized();
    const t0 = performance.now();

    let sql = 'SELECT * FROM memory_entries WHERE 1=1';
    const params: unknown[] = [];

    if (query.namespace) { sql += ' AND namespace = ?'; params.push(query.namespace); }
    if (query.memoryType) { sql += ' AND type = ?'; params.push(query.memoryType); }
    if (query.ownerId) { sql += ' AND owner_id = ?'; params.push(query.ownerId); }
    if (query.accessLevel) { sql += ' AND access_level = ?'; params.push(query.accessLevel); }
    if (query.key) {
      sql += ' AND key = ?'; params.push(query.key);
    } else if (query.keyPrefix) {
      sql += ' AND key LIKE ?'; params.push(query.keyPrefix + '%');
    }
    if (query.createdAfter !== undefined) { sql += ' AND created_at >= ?'; params.push(query.createdAfter); }
    if (query.createdBefore !== undefined) { sql += ' AND created_at <= ?'; params.push(query.createdBefore); }
    if (query.updatedAfter !== undefined) { sql += ' AND updated_at >= ?'; params.push(query.updatedAfter); }
    if (query.updatedBefore !== undefined) { sql += ' AND updated_at <= ?'; params.push(query.updatedBefore); }
    if (!query.includeExpired) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(Date.now());
    }

    sql += ' ORDER BY created_at DESC';
    if (query.limit) { sql += ' LIMIT ?'; params.push(query.limit); }
    if (query.offset) { sql += ' OFFSET ?'; params.push(query.offset); }

    const rows = this.db!.prepare(sql).all(...(params as (string | number | bigint | Buffer | null)[])) as RowShape[];
    const results: MemoryEntry[] = [];
    for (const row of rows) {
      const entry = this.rowToEntry(row);

      if (query.tags && query.tags.length > 0) {
        if (!query.tags.every((tag) => entry.tags.includes(tag))) continue;
      }
      if (query.metadata) {
        const ok = Object.entries(query.metadata).every(
          ([k, v]) => (entry.metadata as Record<string, unknown>)[k] === v
        );
        if (!ok) continue;
      }
      results.push(entry);
    }

    const duration = performance.now() - t0;
    this.stats.queryCount++;
    this.stats.totalQueryTime += duration;
    this.emit('query:executed', { query, resultCount: results.length, duration });
    return results;
  }

  async search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]> {
    this.ensureInitialized();

    const entries = await this.query({
      type: 'hybrid',
      limit: options.filters?.limit ?? 1000,
    });

    const results: SearchResult[] = [];
    for (const entry of entries) {
      if (!entry.embedding) continue;
      const similarity = cosineSimilarity(embedding, entry.embedding);
      if (options.threshold !== undefined && similarity < options.threshold) continue;
      results.push({ entry, score: similarity, distance: 1 - similarity });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.k);
  }

  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    this.ensureInitialized();

    // Wrap in a transaction so the whole batch lands atomically and shares
    // one fsync — meaningful win for 100+ entry inserts. Guarded against
    // re-entry: node:sqlite throws on nested BEGIN, so honor an outer
    // transaction if a caller already opened one.
    await this.runInTransaction(async () => {
      for (const entry of entries) await this.store(entry);
    });

    this.emit('bulk:inserted', { count: entries.length });
  }

  async bulkDelete(ids: string[]): Promise<number> {
    this.ensureInitialized();

    let count = 0;
    await this.runInTransaction(async () => {
      for (const id of ids) {
        const ok = await this.delete(id);
        if (ok) count++;
      }
    });

    this.emit('bulk:deleted', { count });
    return count;
  }

  /**
   * Run `fn` inside a transaction, skipping BEGIN/COMMIT when one is already
   * open. node:sqlite throws on nested BEGIN; better-sqlite3 has
   * `db.transaction(fn)` for this, but the built-in engine doesn't.
   */
  private async runInTransaction(fn: () => Promise<void>): Promise<void> {
    const owns = !this.db!.isTransaction;
    // BEGIN IMMEDIATE so busy_handler engages on multi-process contention
    // (#1099 — plain BEGIN's read→write upgrade fails fast under WAL).
    if (owns) this.db!.exec('BEGIN IMMEDIATE');
    try {
      await fn();
      if (owns) this.db!.exec('COMMIT');
    } catch (err) {
      if (owns) {
        try { this.db!.exec('ROLLBACK'); } catch { /* already aborted */ }
      }
      throw err;
    }
  }

  async count(namespace?: string): Promise<number> {
    this.ensureInitialized();
    const row = namespace
      ? this.stmts.countByNamespace!.get(namespace) as RowShape | undefined
      : this.stmts.countAll!.get() as RowShape | undefined;
    return Number(row?.c ?? 0);
  }

  async listNamespaces(): Promise<string[]> {
    this.ensureInitialized();
    const rows = this.stmts.listNamespaces!.all() as RowShape[];
    return rows.map((r) => r.namespace as string);
  }

  async clearNamespace(namespace: string): Promise<number> {
    this.ensureInitialized();
    const before = await this.count(namespace);
    this.stmts.deleteByNamespace!.run(namespace);
    this.emit('namespace:cleared', { namespace, count: before });
    return before;
  }

  async getStats(): Promise<BackendStats> {
    this.ensureInitialized();

    // Single GROUP BY scan replaces N namespace queries + 5 type queries
    // (reviewer flag — getStats is called from health checks).
    const rows = this.db!
      .prepare('SELECT namespace, type, COUNT(*) AS c FROM memory_entries GROUP BY namespace, type')
      .all() as RowShape[];

    const entriesByNamespace: Record<string, number> = {};
    const entriesByType: Record<MemoryType, number> = {
      episodic: 0, semantic: 0, procedural: 0, working: 0, cache: 0,
    };
    let total = 0;
    for (const row of rows) {
      const ns = String(row.namespace);
      const type = row.type as MemoryType;
      const c = Number(row.c);
      total += c;
      entriesByNamespace[ns] = (entriesByNamespace[ns] ?? 0) + c;
      if (type in entriesByType) entriesByType[type] = (entriesByType[type] ?? 0) + c;
    }

    return {
      totalEntries: total,
      entriesByNamespace,
      entriesByType,
      memoryUsage: this.estimateMemoryUsage(),
      avgQueryTime: this.stats.queryCount > 0
        ? this.stats.totalQueryTime / this.stats.queryCount
        : 0,
      avgSearchTime: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const issues: string[] = [];
    const storageStart = performance.now();
    const storageHealthy = this.db !== null;
    const storageLatency = performance.now() - storageStart;

    if (!storageHealthy) issues.push('Database not initialized');

    const indexHealth: ComponentHealth = {
      status: 'healthy',
      latency: 0,
      message: 'No vector index (brute-force search)',
    };
    const cacheHealth: ComponentHealth = {
      status: 'healthy',
      latency: 0,
      message: 'No separate cache layer',
    };

    return {
      status: issues.length === 0 ? 'healthy' : 'degraded',
      components: {
        storage: {
          status: storageHealthy ? 'healthy' : 'unhealthy',
          latency: storageLatency,
        },
        index: indexHealth,
        cache: cacheHealth,
      },
      timestamp: Date.now(),
      issues,
      recommendations: ['Consider using MofloDbAdapter for HNSW-indexed vector search'],
    };
  }

  /**
   * No-op for parity with {@link SqlJsBackend.persist}. node:sqlite writes
   * straight to the OS file handle — there is no in-memory image to flush.
   */
  async persist(): Promise<void> {
    if (!this.db || this.config.databasePath === ':memory:') return;
    // Checkpoint the WAL into the main DB file. The :memory: and readonly
    // cases are already returned above, so a failure here is a real disk-
    // level problem (disk full, locked file, corrupted WAL) — surface it.
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch (err) {
      if (this.config.verbose) {
        console.warn(`[SqliteBackend] wal_checkpoint failed: ${(err as Error).message}`);
      }
      this.emit('error', { operation: 'persist', error: err });
    }
    this.emit('persisted', { path: this.config.databasePath });
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('SqliteBackend not initialized. Call initialize() first.');
    }
  }

  private rowToEntry(row: RowShape): MemoryEntry {
    return {
      id: row.id as string,
      key: row.key as string,
      content: row.content as string,
      embedding: row.embedding ? blobToFloat32(row.embedding, this.config.verbose) : undefined,
      type: row.type as MemoryType,
      namespace: row.namespace as string,
      tags: JSON.parse((row.tags as string) ?? '[]'),
      metadata: JSON.parse((row.metadata as string) ?? '{}'),
      ownerId: (row.owner_id as string | null) ?? undefined,
      accessLevel: row.access_level as MemoryEntry['accessLevel'],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: row.expires_at != null ? Number(row.expires_at) : undefined,
      version: Number(row.version ?? 1),
      references: JSON.parse((row.references as string) ?? '[]'),
      accessCount: Number(row.access_count ?? 0),
      lastAccessedAt: Number(row.last_accessed_at ?? 0),
    };
  }

  private updateAccessTracking(id: string): void {
    if (!this.db) return;
    this.stmts.updateAccess!.run(Date.now(), id);
  }

  private estimateMemoryUsage(): number {
    if (!this.db || !this.cachedPageSize) return 0;
    try {
      const row = this.db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined;
      return Number(row?.page_count ?? 0) * this.cachedPageSize;
    } catch {
      return 0;
    }
  }
}

/**
 * Convert a stored embedding cell to Float32Array. Handles both BLOB shape
 * (from {@link SqlJsBackend} / this backend) and TEXT-JSON shape (from DBs
 * created via MEMORY_SCHEMA_V3 — the discrepancy called out in epic #1078
 * Phase 0). Logs on malformed inputs because a silently-truncated embedding
 * returns wrong search results.
 */
function blobToFloat32(cell: unknown, verbose: boolean): Float32Array {
  const toView = (view: Uint8Array): Float32Array => {
    if (view.byteLength % 4 !== 0) {
      if (verbose) {
        console.warn(`[SqliteBackend] embedding BLOB byteLength ${view.byteLength} not aligned to Float32 — returning empty`);
      }
      return new Float32Array(0);
    }
    // Copy into a fresh ArrayBuffer so the returned view is detached from
    // any SharedArrayBuffer the SQLite binding may hand us.
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return new Float32Array(copy.buffer);
  };
  if (cell instanceof Uint8Array) return toView(cell);
  if (Buffer.isBuffer(cell)) return toView(cell);
  if (typeof cell === 'string') {
    try {
      const arr = JSON.parse(cell);
      return new Float32Array(Array.isArray(arr) ? arr : []);
    } catch {
      if (verbose) console.warn('[SqliteBackend] embedding TEXT cell unparseable — returning empty');
      return new Float32Array(0);
    }
  }
  return new Float32Array(0);
}
