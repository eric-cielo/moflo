/**
 * SQLite-backed Persistent Cache for Embeddings (node:sqlite)
 *
 * Features:
 * - Built-in node:sqlite (Node 22+) — no native compile, no WASM
 * - Disk persistence via WAL — writes are incremental, no whole-file dumps
 * - LRU eviction with configurable max size
 * - Automatic schema creation
 * - TTL support for cache entries
 * - Lazy initialization (no startup cost if not used)
 *
 * Phase 5 (#1084) migrated this from sql.js to node:sqlite via the unified
 * `openDaemonDatabase` factory. The sql.js whole-file-export pattern was the
 * source of the multi-writer clobber class fixed in epic #1078.
 */

import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../memory/daemon-backend.js';

/**
 * Configuration for persistent cache
 */
export interface PersistentCacheConfig {
  /** Path to SQLite database file */
  dbPath: string;
  /** Maximum number of entries (default: 10000) */
  maxSize?: number;
  /** TTL in milliseconds (default: 7 days) */
  ttlMs?: number;
  /** Enable compression for large embeddings */
  compress?: boolean;
  /** Auto-save interval in ms (default: 30000) */
  autoSaveInterval?: number;
}

/**
 * Cache statistics
 */
export interface PersistentCacheStats {
  size: number;
  maxSize: number;
  hitRate: number;
  hits: number;
  misses: number;
  dbSizeBytes?: number;
}

/**
 * SQLite-backed persistent embedding cache using node:sqlite via the
 * unified daemon-backend factory.
 */
export class PersistentEmbeddingCache {
  private db: SqlJsLikeDatabase | null = null;
  private initialized = false;
  private dirty = false;
  private hits = 0;
  private misses = 0;

  private readonly dbPath: string;
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly autoSaveInterval: number;

  constructor(config: PersistentCacheConfig) {
    this.dbPath = config.dbPath;
    this.maxSize = config.maxSize ?? 10000;
    this.ttlMs = config.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    // Kept for API compatibility; node:sqlite WAL persists incrementally so
    // there's no auto-save timer to drive any more.
    this.autoSaveInterval = config.autoSaveInterval ?? 30000;
  }

  /**
   * Lazily initialize database connection.
   *
   * Phase 5 (#1084): swapped the sql.js readFileSync + new SQL.Database
   * round-trip for openDaemonDatabase(dbPath). WAL writes incrementally so
   * the auto-save timer + saveToFile() that used to live here are gone.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure directory exists (openDaemonDatabase also does this, but the
      // dbExisted probe below needs the path to be stable first).
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const dbExisted = existsSync(this.dbPath);
      this.db = openDaemonDatabase(this.dbPath);

      // Create schema
      this.db.run(`
        CREATE TABLE IF NOT EXISTS embeddings (
          key TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          access_count INTEGER DEFAULT 1
        )
      `);
      this.db.run('CREATE INDEX IF NOT EXISTS idx_accessed_at ON embeddings(accessed_at)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_created_at ON embeddings(created_at)');

      // `embeddings_version` marker for the migration driver (epic #527).
      // Only seed the marker when the DB file is brand new. Pre-existing
      // caches deliberately lack the marker so story 3's open-time check can
      // treat them as pre-v2 (hash-backed) and invalidate them on upgrade.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
      `);
      if (!dbExisted) {
        this.db.run(
          `INSERT OR IGNORE INTO metadata (key, value, updated_at)
           VALUES ('embeddings_version', '2', strftime('%s', 'now') * 1000)`,
        );
      }

      // Clean expired entries on startup
      this.cleanExpired();

      this.initialized = true;
    } catch (error) {
      // node:sqlite is built into Node 22+, so failure here is a real fault
      // (corrupt DB, permission error, etc.) rather than missing dep. Surface
      // and disable the cache so the embedding pipeline keeps working.
      console.warn('[persistent-cache] disabled:',
        error instanceof Error ? error.message : error);
      this.initialized = true; // Mark as initialized to prevent retry
    }
  }

  /**
   * Generate cache key from text
   */
  private hashKey(text: string): string {
    // FNV-1a hash for fast, deterministic key generation
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return `emb_${hash.toString(16)}_${text.length}`;
  }

  /**
   * Serialize Float32Array to Uint8Array for sql.js
   */
  private serializeEmbedding(embedding: Float32Array): Uint8Array {
    return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  /**
   * Deserialize Uint8Array to Float32Array
   */
  private deserializeEmbedding(data: Uint8Array, dimensions: number): Float32Array {
    const buffer = new ArrayBuffer(data.length);
    const view = new Uint8Array(buffer);
    view.set(data);
    return new Float32Array(buffer);
  }

  /**
   * Get embedding from cache
   */
  async get(text: string): Promise<Float32Array | null> {
    await this.ensureInitialized();
    if (!this.db) {
      this.misses++;
      return null;
    }

    const key = this.hashKey(text);
    const now = Date.now();

    try {
      const stmt = this.db.prepare(`
        SELECT embedding, dimensions, created_at
        FROM embeddings
        WHERE key = ?
      `);
      stmt.bind([key]);

      if (!stmt.step()) {
        stmt.free();
        this.misses++;
        return null;
      }

      const row = stmt.getAsObject() as {
        embedding: Uint8Array;
        dimensions: number;
        created_at: number;
      };
      stmt.free();

      // Check TTL
      if (now - row.created_at > this.ttlMs) {
        this.db.run('DELETE FROM embeddings WHERE key = ?', [key]);
        this.dirty = true;
        this.misses++;
        return null;
      }

      // Update access time and count
      this.db.run(`
        UPDATE embeddings
        SET accessed_at = ?, access_count = access_count + 1
        WHERE key = ?
      `, [now, key]);
      this.dirty = true;

      this.hits++;
      return this.deserializeEmbedding(row.embedding, row.dimensions);
    } catch (error) {
      console.error('[persistent-cache] Get error:', error);
      this.misses++;
      return null;
    }
  }

  /**
   * Store embedding in cache
   */
  async set(text: string, embedding: Float32Array): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;

    const key = this.hashKey(text);
    const now = Date.now();
    const data = this.serializeEmbedding(embedding);

    try {
      // Upsert entry using INSERT OR REPLACE
      this.db.run(`
        INSERT OR REPLACE INTO embeddings
        (key, embedding, dimensions, created_at, accessed_at, access_count)
        VALUES (?, ?, ?, ?, ?,
          COALESCE((SELECT access_count + 1 FROM embeddings WHERE key = ?), 1)
        )
      `, [key, data, embedding.length, now, now, key]);
      this.dirty = true;

      // Check size and evict if needed
      await this.evictIfNeeded();
    } catch (error) {
      console.error('[persistent-cache] Set error:', error);
    }
  }

  /**
   * Evict oldest entries if cache exceeds max size
   */
  private async evictIfNeeded(): Promise<void> {
    if (!this.db) return;

    const result = this.db.exec('SELECT COUNT(*) as count FROM embeddings');
    const count = result[0]?.values[0]?.[0] as number ?? 0;

    if (count > this.maxSize) {
      const toDelete = count - this.maxSize + Math.floor(this.maxSize * 0.1); // Delete 10% extra
      this.db.run(`
        DELETE FROM embeddings
        WHERE key IN (
          SELECT key FROM embeddings
          ORDER BY accessed_at ASC
          LIMIT ?
        )
      `, [toDelete]);
      this.dirty = true;
    }
  }

  /**
   * Clean expired entries
   */
  private cleanExpired(): void {
    if (!this.db) return;

    const cutoff = Date.now() - this.ttlMs;
    this.db.run('DELETE FROM embeddings WHERE created_at < ?', [cutoff]);
    this.dirty = true;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<PersistentCacheStats> {
    await this.ensureInitialized();

    const total = this.hits + this.misses;
    const stats: PersistentCacheStats = {
      size: 0,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
      hits: this.hits,
      misses: this.misses,
    };

    if (this.db) {
      const result = this.db.exec('SELECT COUNT(*) as count FROM embeddings');
      stats.size = result[0]?.values[0]?.[0] as number ?? 0;

      // Get file size if exists. node:sqlite leaves the file on disk via WAL
      // so statSync is enough — no whole-file read needed (sql.js used to
      // readFileSync the entire DB to compute size).
      if (existsSync(this.dbPath)) {
        try {
          stats.dbSizeBytes = statSync(this.dbPath).size;
        } catch {
          // Ignore
        }
      }
    }

    return stats;
  }

  /**
   * Clear all cached entries. WAL persists the DELETE incrementally so
   * there's no explicit flush — Phase 5 (#1084) removed the sql.js
   * whole-file save here.
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;

    this.db.run('DELETE FROM embeddings');
    this.hits = 0;
    this.misses = 0;
    this.dirty = false;
  }

  /**
   * Force save to disk. node:sqlite + WAL persists each `db.run` immediately,
   * so flush is a no-op kept for API compatibility.
   */
  async flush(): Promise<void> {
    await this.ensureInitialized();
    this.dirty = false;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

/**
 * Check if persistent cache is available. node:sqlite is built into Node 22+
 * (moflo's minimum) so this always succeeds; kept for API compatibility.
 *
 * Loads the warning-suppression side-effect BEFORE the probe import so the
 * once-per-process ExperimentalWarning doesn't leak to stderr (#1098).
 */
export async function isPersistentCacheAvailable(): Promise<boolean> {
  try {
    await import('../memory/suppress-sqlite-warning.js');
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
