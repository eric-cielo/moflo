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
import {
  legacyMemoryDbPath,
  memoryDbPath,
  MOFLO_DIR,
} from '../services/moflo-paths.js';

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
    // `.moflo/moflo.db` is the canonical post-#727 marker. Older consumers
    // mid-migration may still only have `.swarm/memory.db`; recognise both
    // so the bridge can find the project root either way.
    if (fs.existsSync(memoryDbPath(dir)) || fs.existsSync(legacyMemoryDbPath(dir))) {
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

/**
 * Resolve the on-disk DB path the bridge should read/write.
 *
 * Default to `.moflo/moflo.db`, but during the post-#727 migration window —
 * after a consumer upgrades but before the next session-start launcher fires
 * — prefer `.swarm/memory.db` if only the legacy file exists. Without this
 * preference, any CLI command (e.g. `moflo doctor`) that opens the bridge
 * before the launcher runs would create an empty canonical, defeating the
 * launcher's `target-exists` short-circuit and stranding the user's data in
 * `.swarm/memory.db`.
 *
 * Exported for test access; production callers go through the no-arg
 * `getDbPath()` wrapper below.
 */
export function resolveBridgeDbPath(root: string, customPath?: string): string {
  const canonical = memoryDbPath(root);
  if (!customPath) {
    if (!fs.existsSync(canonical) && fs.existsSync(legacyMemoryDbPath(root))) {
      return legacyMemoryDbPath(root);
    }
    return canonical;
  }
  if (customPath === ':memory:') return ':memory:';
  const resolved = path.resolve(customPath);
  const rel = path.relative(root, resolved);
  // Reject anything that escapes the project root or is an absolute path
  // outside it (path.relative returns an absolute path on different drives).
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return canonical;
  }
  return resolved;
}

function getDbPath(customPath?: string): string {
  return resolveBridgeDbPath(getProjectRoot(), customPath);
}

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Returns null if the memory module cannot be loaded or sql.js fails to open —
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
  // Mirror the read-side resolution so writes land where reads come from.
  // Important during the migration window (#727): if we read from
  // `.swarm/memory.db` because the canonical doesn't exist yet, writing back
  // there keeps the legacy file fresh until the launcher relocates it.
  const target = dbPath ? path.resolve(dbPath) : getDbPath();
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
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived')),
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

/** Stats payload that goes into `.moflo/vector-stats.json`. */
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
  const cacheDir = path.join(rootDir, '.moflo');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'vector-stats.json'),
    JSON.stringify({ ...stats, updatedAt: Date.now() }),
  );
}

/** Probe for the HNSW index sidecar at its canonical post-#727 location. */
function detectHnswIndex(rootDir: string): boolean {
  try { fs.statSync(path.join(rootDir, MOFLO_DIR, 'hnsw.index')); return true; }
  catch { return false; }
}

/**
 * Read the existing on-disk vector-stats cache. Returns null when missing
 * or unparseable — callers treat that as "no prior cache to preserve".
 */
function readExistingVectorStats(rootDir: string): { vectorCount?: number; updatedAt?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, '.moflo', 'vector-stats.json'), 'utf-8'));
  } catch {
    return null;
  }
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

    const root = getProjectRoot();
    const dbFile = dbPathOverride || getDbPath();
    const existing = readExistingVectorStats(root);

    // Mtime short-circuit (#639 perf): refreshVectorStatsCache fires on every
    // bridge store/delete. When the on-disk DB hasn't changed since we last
    // wrote the cache (the common case mid-session — bridge writes don't
    // touch the file until persist), running 3 COUNT queries is wasted work.
    // Skip the rest entirely.
    let dbMtimeMs = 0;
    let dbSizeKB = 0;
    try {
      const stat = fs.statSync(dbFile);
      dbMtimeMs = stat.mtimeMs;
      dbSizeKB = Math.floor(stat.size / 1024);
    } catch { /* file may not exist */ }
    if (
      existing &&
      typeof existing.updatedAt === 'number' &&
      typeof existing.vectorCount === 'number' &&
      existing.vectorCount > 0 &&
      dbMtimeMs > 0 &&
      existing.updatedAt >= dbMtimeMs
    ) {
      return;
    }

    let vectorCount = 0;
    let namespaces = 0;
    let missing = 0;
    let queriesSucceeded = false;

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
      queriesSucceeded = true;
    } catch {
      // Table may not exist yet — leave queriesSucceeded=false so the
      // anti-clobber guard below skips the write.
    }

    // Anti-clobber guard (#639): if our queries failed OR returned all-zero
    // counts but a previous cache reports populated counts, leave the cache
    // alone. The registry's DB context is sometimes a freshly-opened or
    // partially-initialized handle that doesn't reflect the on-disk truth —
    // overwriting a known-good cache with zeros makes the statusline show
    // `Vectors ●0` even though the DB has thousands of embedded rows. The
    // legitimate "DB became empty" case is rare enough that requiring a
    // successful explicit write from the bin/build-embeddings.mjs path is
    // acceptable.
    if (!queriesSucceeded || (vectorCount === 0 && namespaces === 0 && missing === 0)) {
      if (existing && typeof existing.vectorCount === 'number' && existing.vectorCount > 0) {
        return;
      }
    }

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
