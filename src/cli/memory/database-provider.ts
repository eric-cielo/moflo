/**
 * DatabaseProvider — moflo's IMemoryBackend factory.
 *
 * Phase 5 (#1084) removed the sql.js backend. Selection now collapses to:
 * - `node-sqlite` (Node 22+ built-in, the only SQLite backend)
 * - `rvf` (pure-TS fallback when node:sqlite is somehow unavailable)
 * - `json` (last-resort file storage when nothing else works)
 *
 * @module v3/memory/database-provider
 */

import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryInput,
  MemoryQuery,
  SearchOptions,
  SearchResult,
  BackendStats,
  HealthCheckResult,
  MemoryEntryUpdate,
} from './types.js';
import { SqliteBackend, SqliteBackendConfig } from './sqlite-backend.js';

/**
 * Available database provider types.
 *
 * `sql.js` is retained as a literal-only value (no backend) so existing
 * callers can be migrated incrementally — passing it now throws, surfacing
 * the stale dependency at the call site rather than silently dropping back.
 */
export type DatabaseProvider = 'sql.js' | 'node-sqlite' | 'json' | 'rvf' | 'auto';

/**
 * Canonical label returned in MCP `backend` fields and other consumer-visible
 * surfaces. Single source of truth so a future engine swap is a one-line edit
 * instead of an 8-site grep. Phase 5 (#1084) finalized node:sqlite as the
 * only SQLite backend; the HNSW vector index sits on top.
 */
export const BACKEND_LABEL = 'node:sqlite + HNSW';

/**
 * Database creation options
 */
export interface DatabaseOptions {
  /** Preferred provider (auto = platform-aware selection) */
  provider?: DatabaseProvider;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Enable WAL mode (applied by node:sqlite). */
  walMode?: boolean;

  /** Enable query optimization */
  optimize?: boolean;

  /** Default namespace */
  defaultNamespace?: string;

  /** Maximum entries before auto-cleanup */
  maxEntries?: number;

  /** Auto-persist interval — retained for API compatibility; node:sqlite
   *  persists incrementally via WAL so this is effectively a no-op. */
  autoPersistInterval?: number;

  /** Retained for API compatibility — sql.js wasm path is no longer honoured. */
  wasmPath?: string;
}

/**
 * Platform detection result
 */
interface PlatformInfo {
  os: string;
  isWindows: boolean;
  isMacOS: boolean;
  isLinux: boolean;
  recommendedProvider: DatabaseProvider;
}

/**
 * Detect platform and recommend provider
 */
function detectPlatform(): PlatformInfo {
  const os = platform();
  const isWindows = os === 'win32';
  const isMacOS = os === 'darwin';
  const isLinux = os === 'linux';

  // Phase 4 (#1083) flipped the default to node:sqlite (built into Node 22+,
  // moflo's minimum). Phase 5 (#1084) deletes the sql.js backend + dep.
  const recommendedProvider: DatabaseProvider = 'node-sqlite';

  return {
    os,
    isWindows,
    isMacOS,
    isLinux,
    recommendedProvider,
  };
}

/**
 * Test if RVF backend is available (always true — pure-TS fallback)
 */
async function testRvf(): Promise<boolean> {
  return true;
}

/**
 * Test if the built-in node:sqlite engine is available (Node 22+).
 *
 * Loads the suppress-sqlite-warning side-effect BEFORE the probe import so
 * the once-per-process ExperimentalWarning never fires (#1098). A probe
 * that prints the warning to stderr defeats every consumer's "clean
 * startup" expectation even when the rest of the run is healthy.
 */
async function testNodeSqlite(): Promise<boolean> {
  try {
    await import('./suppress-sqlite-warning.js');
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * Select best available provider.
 *
 * Phase 5 (#1084) collapsed the chain — sql.js is gone, so the order is
 * just: explicit override → node:sqlite → RVF → JSON. Passing `'sql.js'`
 * explicitly is a hard error.
 */
async function selectProvider(
  preferred?: DatabaseProvider,
  verbose: boolean = false
): Promise<DatabaseProvider> {
  if (preferred === 'sql.js') {
    throw new Error(
      `DatabaseProvider: sql.js was removed in Phase 5 (#1084). ` +
      `Use 'node-sqlite' (the new default) or omit the provider entirely.`,
    );
  }
  if (preferred && preferred !== 'auto') {
    if (verbose) {
      console.log(`[DatabaseProvider] Using explicitly specified provider: ${preferred}`);
    }
    return preferred;
  }

  if (await testNodeSqlite()) {
    if (verbose) {
      console.log('[DatabaseProvider] node:sqlite available — using new default');
    }
    return 'node-sqlite';
  }

  // node:sqlite missing is the "broken install" signal — surface it whenever
  // verbose is on so the fallback chain doesn't silently regress consumers
  // to a slower backend without anyone noticing.
  if (verbose) {
    console.warn('[DatabaseProvider] node:sqlite unavailable — check Node version (22+ required); falling back to RVF');
  }

  if (await testRvf()) {
    return 'rvf';
  }

  if (verbose) {
    console.warn('[DatabaseProvider] node:sqlite + RVF unavailable — falling back to JSON');
  }
  return 'json';
}

/**
 * Create a database instance with platform-aware provider selection
 *
 * @param path - Database file path (:memory: for in-memory)
 * @param options - Database configuration options
 * @returns Initialized database backend
 *
 * @example
 * ```typescript
 * // Auto-select best provider for platform
 * const db = await createDatabase('./data/memory.db');
 *
 * // Force specific provider
 * const db = await createDatabase('./data/memory.db', {
 *   provider: 'sql.js'
 * });
 *
 * // With custom options
 * const db = await createDatabase('./data/memory.db', {
 *   verbose: true,
 *   optimize: true,
 *   autoPersistInterval: 10000
 * });
 * ```
 */
export async function createDatabase(
  path: string,
  options: DatabaseOptions = {}
): Promise<IMemoryBackend> {
  const {
    provider,
    verbose = false,
    walMode: _walMode = true,
    optimize = true,
    defaultNamespace = 'default',
    maxEntries = 1000000,
    autoPersistInterval = 5000,
    wasmPath: _wasmPath,
  } = options;

  // When no explicit provider is given, consult moflo.yaml's
  // `memory.backend` knob (#1144). This is what makes the YAML value
  // truthful instead of cosmetic — the runtime now actually honours
  // whatever the consumer put in their config. Falls back to `'auto'` if
  // the config can't be loaded (e.g. running from a directory with no
  // `moflo.yaml`), preserving the previous behaviour for raw callers.
  const effectiveProvider: DatabaseProvider =
    provider ?? (await preferredProviderFromConfig(verbose)) ?? 'auto';

  const selectedProvider = await selectProvider(effectiveProvider, verbose);

  if (verbose) {
    console.log(`[DatabaseProvider] Creating database with provider: ${selectedProvider}`);
    console.log(`[DatabaseProvider] Database path: ${path}`);
  }

  let backend: IMemoryBackend;

  switch (selectedProvider) {
    case 'sql.js': {
      // selectProvider() guards against 'sql.js' as an explicit preference,
      // but a stale caller could still land here if `auto` resolution drifted
      // (it can't — left only for exhaustive-check safety).
      throw new Error(
        `DatabaseProvider: sql.js was removed in Phase 5 (#1084). ` +
        `This case is unreachable; if you see this error, file a bug.`,
      );
    }

    case 'node-sqlite': {
      const config: Partial<SqliteBackendConfig> = {
        databasePath: path,
        optimize,
        defaultNamespace,
        maxEntries,
        verbose,
        autoPersistInterval,
      };

      backend = new SqliteBackend(config);
      break;
    }

    case 'rvf': {
      const { RvfBackend } = await import('./rvf-backend.js');
      backend = new RvfBackend({
        databasePath: path.replace(/\.(db|json)$/, '.rvf'),
        dimensions: 1536,
        verbose,
        defaultNamespace,
        autoPersistInterval,
      });
      break;
    }

    case 'json': {
      // Simple JSON file backend (minimal implementation)
      backend = new JsonBackend(path, verbose);
      break;
    }

    default:
      throw new Error(`Unknown database provider: ${selectedProvider}`);
  }

  // Initialize the backend
  await backend.initialize();

  if (verbose) {
    console.log(`[DatabaseProvider] Database initialized successfully`);
  }

  return backend;
}

/**
 * Get platform information
 */
export function getPlatformInfo(): PlatformInfo {
  return detectPlatform();
}

/**
 * Read `memory.backend` from the project's `moflo.yaml`, resolve any
 * deprecated aliases (sql.js → node-sqlite), and return a value
 * `selectProvider()` understands. Returns `null` on any failure so
 * `createDatabase()` cleanly falls back to platform auto-detection
 * — config loading must never break the runtime.
 *
 * Wrapped in a dynamic import so the memory subtree doesn't pull
 * `js-yaml` / `fs` into hot paths (e.g. the in-memory test backend).
 *
 * Memoised per (cwd, process) — a test suite or daemon that opens many
 * DBs in sequence parses moflo.yaml once. Keyed on cwd so a test that
 * `chdir`s into a temp dir gets a fresh resolution.
 */
const _resolvedProviderCache = new Map<string, DatabaseProvider | null>();

async function preferredProviderFromConfig(verbose: boolean): Promise<DatabaseProvider | null> {
  const key = process.cwd();
  if (_resolvedProviderCache.has(key)) {
    return _resolvedProviderCache.get(key) ?? null;
  }
  try {
    const { loadMofloConfig, resolveDatabaseProvider } = await import(
      '../config/moflo-config.js'
    );
    const cfg = loadMofloConfig();
    const resolved = resolveDatabaseProvider(cfg.memory.backend);
    if (verbose) {
      console.log(
        `[DatabaseProvider] moflo.yaml memory.backend="${cfg.memory.backend}" → ${resolved}`,
      );
    }
    _resolvedProviderCache.set(key, resolved);
    return resolved;
  } catch (err) {
    if (verbose) {
      console.warn(
        `[DatabaseProvider] Could not load moflo.yaml backend preference (${
          (err as Error).message
        }) — falling back to auto-detection`,
      );
    }
    _resolvedProviderCache.set(key, null);
    return null;
  }
}

/** @internal — test hook only; resets the per-cwd cache between cases. */
export function _resetPreferredProviderCache(): void {
  _resolvedProviderCache.clear();
}

/**
 * Check which providers are available.
 *
 * `sqlJs` / `betterSqlite3` are retained for API stability but always
 * report `false` — Phase 5 (#1084) deleted the sql.js backend and
 * better-sqlite3 was never wired.
 */
export async function getAvailableProviders(): Promise<{
  rvf: boolean;
  betterSqlite3: boolean;
  sqlJs: boolean;
  nodeSqlite: boolean;
  json: boolean;
}> {
  return {
    rvf: true,
    betterSqlite3: false,
    sqlJs: false,
    nodeSqlite: await testNodeSqlite(),
    json: true,
  };
}

// ===== JSON Fallback Backend =====

/**
 * Simple JSON file backend for when no SQLite is available
 */
class JsonBackend implements IMemoryBackend {
  private entries: Map<string, MemoryEntry> = new Map();
  private path: string;
  private verbose: boolean;
  private initialized: boolean = false;

  constructor(path: string, verbose: boolean = false) {
    this.path = path;
    this.verbose = verbose;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load from file if exists
    if (this.path !== ':memory:' && existsSync(this.path)) {
      try {
        const fs = await import('node:fs/promises');
        const data = await fs.readFile(this.path, 'utf-8');
        const entries = JSON.parse(data);

        for (const entry of entries) {
          // Convert embedding array back to Float32Array
          if (entry.embedding) {
            entry.embedding = new Float32Array(entry.embedding);
          }
          this.entries.set(entry.id, entry);
        }

        if (this.verbose) {
          console.log(`[JsonBackend] Loaded ${this.entries.size} entries from ${this.path}`);
        }
      } catch (error) {
        if (this.verbose) {
          console.error('[JsonBackend] Error loading file:', error);
        }
      }
    }

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    await this.persist();
    this.initialized = false;
  }

  async store(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, entry);
    await this.persist();
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) || null;
  }

  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    for (const entry of this.entries.values()) {
      if (entry.namespace === namespace && entry.key === key) {
        return entry;
      }
    }
    return null;
  }

  async update(id: string, updateData: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;

    const updated = { ...entry, ...updateData, updatedAt: Date.now(), version: entry.version + 1 };
    this.entries.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.entries.delete(id);
    await this.persist();
    return result;
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    let results = Array.from(this.entries.values());

    if (query.namespace) {
      results = results.filter((e) => e.namespace === query.namespace);
    }

    if (query.key) {
      results = results.filter((e) => e.key === query.key);
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((e) => query.tags!.every((tag) => e.tags.includes(tag)));
    }

    return results.slice(0, query.limit);
  }

  async search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]> {
    // Simple brute-force search
    const results: SearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.embedding) continue;

      const similarity = this.cosineSimilarity(embedding, entry.embedding);
      if (options.threshold && similarity < options.threshold) continue;

      results.push({ entry, score: similarity, distance: 1 - similarity });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.k);
  }

  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
    await this.persist();
  }

  async bulkDelete(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (this.entries.delete(id)) count++;
    }
    await this.persist();
    return count;
  }

  async count(namespace?: string): Promise<number> {
    if (!namespace) return this.entries.size;

    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.namespace === namespace) count++;
    }
    return count;
  }

  async listNamespaces(): Promise<string[]> {
    const namespaces = new Set<string>();
    for (const entry of this.entries.values()) {
      namespaces.add(entry.namespace);
    }
    return Array.from(namespaces);
  }

  async clearNamespace(namespace: string): Promise<number> {
    let count = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.namespace === namespace) {
        this.entries.delete(id);
        count++;
      }
    }
    await this.persist();
    return count;
  }

  async getStats(): Promise<BackendStats> {
    return {
      totalEntries: this.entries.size,
      entriesByNamespace: {},
      entriesByType: {} as any,
      memoryUsage: 0,
      avgQueryTime: 0,
      avgSearchTime: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      status: 'healthy',
      components: {
        storage: { status: 'healthy', latency: 0 },
        index: { status: 'healthy', latency: 0 },
        cache: { status: 'healthy', latency: 0 },
      },
      timestamp: Date.now(),
      issues: [],
      recommendations: ['Consider using SQLite backend for better performance'],
    };
  }

  private async persist(): Promise<void> {
    if (this.path === ':memory:') return;

    const fs = await import('node:fs/promises');
    const entries = Array.from(this.entries.values()).map((e) => ({
      ...e,
      // Convert Float32Array to regular array for JSON serialization
      embedding: e.embedding ? Array.from(e.embedding) : undefined,
    }));

    await fs.writeFile(this.path, JSON.stringify(entries, null, 2));
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
