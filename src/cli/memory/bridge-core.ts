/**
 * Memory bridge — shared primitives: registry singleton, db handle,
 * wrapper, id generation, cosine similarity, vector-stats cache.
 *
 * @module v3/cli/bridge-core
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { atomicWriteFileSync } from '../services/atomic-file-write.js';

// When run via npx, CWD may be node_modules/moflo — walk up to find actual project
let _projectRoot: string | undefined;

/**
 * Reset the cached project root. Tests that change `process.cwd()` or
 * `process.env.CLAUDE_PROJECT_DIR` between cases must call this to avoid
 * leaking state across tests.
 */
export function _resetProjectRootForTest(): void {
  _projectRoot = undefined;
}

function getProjectRoot(): string {
  if (_projectRoot) return _projectRoot;
  if (process.env.CLAUDE_PROJECT_DIR) {
    _projectRoot = process.env.CLAUDE_PROJECT_DIR;
    return _projectRoot;
  }
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm', 'memory.db'))) {
      _projectRoot = dir;
      return _projectRoot;
    }
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) && fs.existsSync(path.join(dir, 'package.json'))) {
      _projectRoot = dir;
      return _projectRoot;
    }
    if (path.basename(dir) === 'node_modules') {
      dir = path.dirname(dir);
      continue;
    }
    dir = path.dirname(dir);
  }
  _projectRoot = process.cwd();
  return _projectRoot;
}

import { ControllerRegistry } from './controller-registry.js';

let registryPromise: Promise<any | null> | null = null;
// Sync handle populated once the promise resolves. Lets sync callers
// (refreshVectorStatsCache) read the registry without awaiting.
let resolvedRegistry: any | null = null;
let lastBridgeError: Error | null = null;
const schemaInitialized = new WeakSet<object>();

/** Controllers every moflodb_* MCP tool assumes are present when the bridge is available. */
export const REQUIRED_BRIDGE_CONTROLLERS = Object.freeze([
  'hierarchicalMemory',
  'tieredCache',
  'memoryConsolidation',
  'memoryGraph',
] as const);

/** Last error thrown during bridge init, or null after a successful init. */
export function getBridgeLastError(): Error | null {
  return lastBridgeError;
}

function logBridgeError(context: string, err: unknown): void {
  if (process.env.MOFLO_BRIDGE_QUIET) return;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[moflo] ${context}: ${msg}`);
}

function getDbPath(customPath?: string): string {
  const swarmDir = path.resolve(getProjectRoot(), '.swarm');
  if (!customPath) return path.join(swarmDir, 'memory.db');
  if (customPath === ':memory:') return ':memory:';
  const resolved = path.resolve(customPath);
  const root = getProjectRoot();
  const rel = path.relative(root, resolved);
  // Reject anything that escapes the project root or is an absolute path
  // outside it (path.relative returns an absolute path on different drives).
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return path.join(swarmDir, 'memory.db');
  }
  return resolved;
}

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Returns null if @moflo/memory cannot be loaded or sql.js fails to open —
 * callers fall back to raw sql.js.
 */
export async function getRegistry(dbPath?: string): Promise<any | null> {
  if (!registryPromise) {
    registryPromise = (async () => {
      try {
        const registry = new ControllerRegistry();

        // Suppress noisy init logs
        const origLog = console.log;
        console.log = (...args: unknown[]) => {
          const msg = String(args[0] ?? '');
          if (msg.includes('Transformers.js') ||
              msg.includes('[MofloDb]') ||
              msg.includes('[HNSWLibBackend]') ||
              msg.includes('MoVector graph')) return;
          origLog.apply(console, args);
        };

        try {
          await registry.initialize({
            dbPath: dbPath || getDbPath(),
            dimension: 384,
            controllers: {
              learningBridge: false,
              tieredCache: true,
              hierarchicalMemory: true,
              memoryConsolidation: true,
              memoryGraph: true,
            },
          });
        } finally {
          console.log = origLog;
        }

        resolvedRegistry = registry;
        lastBridgeError = null;
        return registry;
      } catch (err) {
        lastBridgeError = err instanceof Error ? err : new Error(String(err));
        logBridgeError('MofloDb bridge init failed', lastBridgeError);
        registryPromise = null;
        return null;
      }
    })();
  }

  return registryPromise;
}

export interface BridgeDbContext {
  db: any;
  mofloDb: any;
}

/**
 * Read rows from sql.js as an array of column-keyed objects. sql.js doesn't
 * have a `.all()` / `.get()` → object API — the native `Statement.get()`
 * returns a positional array, and `.all()` doesn't exist at all. This is a
 * thin wrapper around `db.exec(sql, bindings)` that converts the
 * `{ columns, values }` shape into objects.
 */
export function execRows(db: any, sql: string, params?: unknown[]): Record<string, unknown>[] {
  const result = params && params.length > 0 ? db.exec(sql, params) : db.exec(sql);
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
    return obj;
  });
}

/**
 * Persist the in-memory sql.js DB back to disk. sql.js is purely in-memory —
 * without an explicit export+writeFileSync after each mutation, writes vanish
 * when the process exits, which breaks store→retrieve across CLI commands.
 */
export function persistBridgeDb(db: any, dbPath?: string): void {
  const target = dbPath
    ? path.resolve(dbPath)
    : path.join(getProjectRoot(), '.swarm', 'memory.db');
  if (target === ':memory:') return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWriteFileSync(target, db.export());
  } catch (err) {
    logBridgeError('bridge persist failed', err);
  }
}

// Kept in sync with MEMORY_SCHEMA_V3.memory_entries in memory-initializer.ts.
// Running `CREATE TABLE IF NOT EXISTS` is a no-op if the initializer already
// ran; when the bridge runs first, matching CHECKs here prevents drift.
const MEMORY_ENTRIES_DDL = `CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic' CHECK(type IN ('semantic', 'episodic', 'procedural', 'working', 'pattern')),
  embedding TEXT,
  embedding_model TEXT DEFAULT 'local',
  embedding_dimensions INTEGER,
  tags TEXT,
  metadata TEXT,
  owner_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  expires_at INTEGER,
  last_accessed_at INTEGER,
  access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
  UNIQUE(namespace, key)
)`;

export function getDb(registry: any): BridgeDbContext | null {
  const mofloDb = registry.getMofloDb();
  if (!mofloDb?.database) return null;

  const db = mofloDb.database;

  if (!schemaInitialized.has(db)) {
    try {
      db.exec(MEMORY_ENTRIES_DDL);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_ns ON memory_entries(namespace)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_key ON memory_entries(key)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_status ON memory_entries(status)`);
      schemaInitialized.add(db);
    } catch {
      // Table already exists or db is read-only — that's fine
    }
  }

  return { db, mofloDb };
}

/**
 * Resolve registry + db, run fn, return null on any unexpected failure so
 * the caller falls back to raw sql.js. Errors are logged to stderr —
 * silently swallowing them previously masked real bugs in bridge-entries.ts.
 */
export async function withDb<T>(
  dbPath: string | undefined,
  fn: (ctx: BridgeDbContext, registry: any) => Promise<T | null>,
): Promise<T | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;
  const ctx = getDb(registry);
  if (!ctx) return null;
  try {
    return await fn(ctx, registry);
  } catch (err) {
    logBridgeError('bridge operation failed', err);
    return null;
  }
}

export async function isBridgeAvailable(dbPath?: string): Promise<boolean> {
  const registry = await getRegistry(dbPath);
  return registry !== null;
}

export async function getControllerRegistry(dbPath?: string): Promise<any | null> {
  return getRegistry(dbPath);
}

export async function shutdownBridge(): Promise<void> {
  if (!registryPromise) return;
  const registry = await registryPromise;
  registryPromise = null;
  resolvedRegistry = null;
  if (registry) {
    try {
      await registry.shutdown();
    } catch {
      // Best-effort
    }
  }
}

export function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const mag = Math.sqrt(normA * normB);
  return mag === 0 ? 0 : dot / mag;
}

/** Stats payload that goes into `.claude-flow/vector-stats.json`. */
export interface VectorStatsPayload {
  vectorCount: number;
  missing: number;
  dbSizeKB: number;
  namespaces: number;
  hasHnsw: boolean;
}

/**
 * Single source of truth for the on-disk vector-stats.json shape. Both the
 * bridge path (refreshVectorStatsCache, this module) and the raw-sql.js
 * fallback (writeVectorStatsCache, memory-initializer.ts) call this so the
 * field order and key set never drift. Issue #639 was caused by exactly that
 * kind of dual-writer divergence.
 */
export function writeVectorStatsJson(rootDir: string, stats: VectorStatsPayload): void {
  const cacheDir = path.join(rootDir, '.claude-flow');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'vector-stats.json'),
    JSON.stringify({ ...stats, updatedAt: Date.now() }),
  );
}

/** Probe both legacy locations for an HNSW index sidecar file. */
function detectHnswIndex(rootDir: string): boolean {
  for (const p of [
    path.join(rootDir, '.swarm', 'hnsw.index'),
    path.join(rootDir, '.claude-flow', 'hnsw.index'),
  ]) {
    try { fs.statSync(p); return true; } catch { /* nope */ }
  }
  return false;
}

/**
 * Write vector-stats.json cache file used by the statusline. Runs
 * synchronously — only fires when the registry is already resolved, so
 * no await is needed on the store/delete hot path.
 */
export function refreshVectorStatsCache(dbPathOverride?: string): void {
  const registry = resolvedRegistry;
  if (!registry) return;

  try {
    const ctx = getDb(registry);
    if (!ctx?.db) return;

    let vectorCount = 0;
    let namespaces = 0;
    let dbSizeKB = 0;
    let missing = 0;

    try {
      // sql.js Statement.get() returns positional arrays — read with execRows()
      // (which wraps db.exec()) to get column-keyed objects. Pre-#649 these
      // reads happened to never fire (the bridge embedder was always missing
      // so bridgeStoreEntry never reached this call), and when fixed they
      // would have clobbered vector-stats.json with zeros via .get().
      const [countRow] = execRows(
        ctx.db,
        "SELECT COUNT(*) as c FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL",
      );
      vectorCount = Number(countRow?.c ?? 0);

      const [nsRow] = execRows(
        ctx.db,
        "SELECT COUNT(DISTINCT namespace) as n FROM memory_entries WHERE status = 'active'",
      );
      namespaces = Number(nsRow?.n ?? 0);

      const [missingRow] = execRows(
        ctx.db,
        "SELECT COUNT(*) as c FROM memory_entries WHERE status = 'active' AND embedding IS NULL",
      );
      missing = Number(missingRow?.c ?? 0);
    } catch {
      // Table may not exist yet
    }

    const dbFile = dbPathOverride || getDbPath();
    try {
      const stat = fs.statSync(dbFile);
      dbSizeKB = Math.floor(stat.size / 1024);
    } catch { /* file may not exist */ }

    const root = getProjectRoot();
    writeVectorStatsJson(root, {
      vectorCount,
      missing,
      dbSizeKB,
      namespaces,
      hasHnsw: detectHnswIndex(root),
    });
  } catch {
    // Non-fatal — statusline falls back to file size estimate
  }
}
