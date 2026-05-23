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
import { findProjectRoot } from '../services/project-root.js';

// When run via npx, CWD may be node_modules/moflo — walk up to find actual project
let _projectRoot: string | undefined;

/**
 * Reset the cached project root. Tests that change `process.cwd()` or
 * `process.env.CLAUDE_PROJECT_DIR` between cases must call this to avoid
 * leaking state across tests.
 *
 * Also drops the bridge-coherence cursor (#1058) so a test that re-points the
 * project root doesn't inherit a stale mtime anchor from the previous root.
 */
export function _resetProjectRootForTest(): void {
  _projectRoot = undefined;
  lastSeenMtimeMs = null;
}

/**
 * Test seam (#1058): peek at the bridge-coherence cursor. Production callers
 * never invoke this; tests assert that own writes update the anchor and that
 * another writer's mtime bump triggers reload.
 */
export function _getBridgeCoherenceCursorForTest(): number | null {
  return lastSeenMtimeMs;
}

/**
 * Candidate-pool ceiling for the brute-force search path (#1201).
 *
 * The bridge search scores candidates one-by-one (cosine + BM25), so it must
 * cap how many rows it pulls. The old `LIMIT 1000` with NO `ORDER BY` truncated
 * by rowid (insertion order): on a populated DB the first 1000 rows are all
 * bulk-indexed `code-map`, so a no-namespace search silently scored ZERO
 * `learnings`/`patterns`/etc. — they were invisible to default recall.
 *
 * The fix pairs this cap with `ORDER BY created_at DESC`, so when truncation
 * does happen (DB larger than the cap) it keeps the most RECENT entries — where
 * curated learnings and recent work live — instead of the oldest rowids.
 * Realistic DBs (thousands–low tens of thousands) fall under the cap and are
 * scored in full; measured ~13ms per 1000 rows. Env-overridable for ops tuning
 * and tests. Beyond the cap, a true HNSW candidate path is the scale answer.
 */
export function searchCandidateCap(): number {
  const raw = Number(process.env.MOFLO_SEARCH_CANDIDATE_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25000;
}

/**
 * Resolve the bridge's project root.
 *
 * Delegates to the canonical resolver in `src/cli/services/project-root.ts`
 * (twin: `bin/lib/moflo-paths.mjs:findProjectRoot()`). The bridge keeps a
 * module-level cache so the hot path (every withDb call) doesn't redo the
 * stat sweep. Tests reset via {@link _resetProjectRootForTest}.
 *
 * If you find yourself wanting to inline a custom walk here, STOP — every
 * divergent walk creates a new path-mismatch bug class (see #1057 / #1058).
 */
function getProjectRoot(): string {
  if (_projectRoot) return _projectRoot;
  _projectRoot = findProjectRoot();
  return _projectRoot;
}

import { ControllerRegistry } from './controller-registry.js';
import { errorDetail } from '../shared/utils/error-detail.js';

let registryPromise: Promise<any | null> | null = null;
// Sync handle populated once the promise resolves. Lets sync callers
// (refreshVectorStatsCache) read the registry without awaiting.
let resolvedRegistry: any | null = null;
let lastBridgeError: Error | null = null;
const schemaInitialized = new WeakSet<object>();

/**
 * Last-known disk mtime for the bridge's dbPath. Anchors the bridge-coherence
 * check (story #1058 / epic #1054): when another process writes to disk, its
 * persist bumps mtime past this value; the next withDb call shuts the bridge
 * down so getRegistry re-reads fresh from disk.
 *
 * Set after every successful persist (own writes; no self-invalidation) and
 * after every successful registry init (anchor to load-time disk state).
 * Reset to null when the bridge is shut down so the next init re-anchors.
 *
 * Module-level because the bridge itself is process-wide singleton state —
 * matches the existing `registryPromise` lifecycle.
 */
let lastSeenMtimeMs: number | null = null;

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

/**
 * Log a bridge error. By default `MOFLO_BRIDGE_QUIET` suppresses the line
 * to keep test output clean for read-path noise. Pass `{ alwaysLog: true }`
 * for write-path errors that mean data did NOT reach disk — those MUST
 * always log, since the quiet env var is for read-path noise control,
 * not for masking data loss (#982 / #854 / #962 anti-pattern).
 */
export function logBridgeError(context: string, err: unknown, opts?: { alwaysLog?: boolean }): void {
  if (process.env.MOFLO_BRIDGE_QUIET && !opts?.alwaysLog) return;
  const msg = errorDetail(err);
  console.error(`[moflo] ${context}: ${msg}`);
}

/**
 * Recognises the node:sqlite "operation on closed handle" error shape.
 *
 * #1123 — A concurrent `withDb` call's `checkBridgeCoherence` can fire
 * `shutdownBridge()` between our `getDb(registry)` and `fn(ctx, registry)`,
 * closing the underlying `DatabaseSync`. Our previously-captured `ctx.db`
 * then throws `ERR_INVALID_STATE: database is not open` on the next op.
 *
 * The operation hadn't started its mutation yet, so a single retry against a
 * fresh registry is safe (matches the `withBusyRetry` shape for SQLITE_BUSY).
 * Bounded to one retry so a *genuinely* broken DB still surfaces — we don't
 * want to mask a registry that can't be re-acquired.
 */
function isStaleHandleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  if (e.code === 'ERR_INVALID_STATE') return true;
  return typeof e.message === 'string' && /database is not open/i.test(e.message);
}

/**
 * Treats an error as a SQLITE_BUSY lock-contention failure if either the
 * error code or message indicates it. Belt-and-suspenders around node:sqlite,
 * whose surface intermittently surfaces busy-conflicts as either `code:
 * 'SQLITE_BUSY'` or a plain `Error: database is locked`. We match both.
 */
function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_BUSY_SNAPSHOT' || e.code === 'SQLITE_BUSY_RECOVERY') return true;
  return typeof e.message === 'string' && /database is locked|SQLITE_BUSY/i.test(e.message);
}

// Exponential backoff with jitter. Total ceiling ≈ 1.55s of waiting (50 +
// 100 + 200 + 400 + 800), plus the work itself. Sized so a typical short
// indexer write (a few rows in auto-commit) finishes before we give up,
// without ballooning bridge latency on a really stuck DB. See #1098.
const BRIDGE_BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

/**
 * Run `fn` with a jittered exponential-backoff retry on SQLITE_BUSY errors.
 *
 * Why this exists: in CI the bridge's parallel doctor-subcheck workload hit
 * "database is locked" 5–7 times in a 5ms window while the configured
 * `busy_timeout=15000ms` should have been retrying for full seconds (#1098).
 * The hypothesis-in-flight is that `node:sqlite`'s `db.prepare()` bypasses
 * the engine-level `busy_handler`, so the busy_timeout pragma never engages
 * for the bridge's prepare-heavy call patterns. Until that's confirmed
 * (#1098 follow-up — local repro), an explicit retry here is the only
 * guard between the consumer and a hard fail.
 *
 * Jitter scatters parallel retries so the workload doesn't thunder back
 * onto the same lock at the same instant.
 */
async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= BRIDGE_BUSY_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const base = BRIDGE_BUSY_RETRY_DELAYS_MS[attempt - 1]!;
      const jitter = base * (Math.random() * 0.5 - 0.25); // ±25%
      const delay = Math.max(0, Math.round(base + jitter));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isBusyError(err)) throw err;
      // Loop continues — backoff applied at top of next iteration.
    }
  }
  throw lastErr;
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
 *
 * Throws on failure (#982). Callers that issued a mutation MUST treat a
 * persist throw as the mutation having failed: the in-memory DB still has
 * the new row, but it never reached disk and dies with the process.
 *
 * Pre-#982 this swallowed silently and logged once to stderr — the
 * `bridgeStoreEntry` path then returned `{ success: true }` despite the
 * data being lost, the success-lie pattern that cost #854 and #962 too.
 *
 * Use {@link tryPersistBridgeDb} for the rare best-effort caller (cache
 * invalidation, idempotent maintenance) that genuinely doesn't care.
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
    // Phase 4 (#1083) — node:sqlite-backed handles persist incrementally via
    // WAL; `save()` on the factory adapter is a no-op for them. Doing the
    // sql.js-style `export()` + `atomicWriteFileSync` against a node:sqlite
    // handle would CLOBBER the WAL writes (the catastrophic case the epic
    // was killing). Route through `save()` when the handle is the factory
    // shape; only fall back to the legacy export-and-write for raw sql.js.
    if (db && db.kind === 'node-sqlite' && typeof db.save === 'function') {
      db.save();
    } else {
      atomicWriteFileSync(target, db.export());
    }
    // Anchor the bridge-coherence cursor to the post-persist mtime so our own
    // write doesn't trigger a self-invalidation on the next withDb call.
    // Under WAL the write lands in `-wal` (not the main file), so include
    // its mtime — must match the read side of checkBridgeCoherence or self-
    // writes self-invalidate (#1098).
    try {
      let anchored = fs.statSync(target).mtimeMs;
      try {
        const walStat = fs.statSync(`${target}-wal`);
        if (walStat.mtimeMs > anchored) anchored = walStat.mtimeMs;
      } catch { /* no WAL sidecar — main mtime is authoritative */ }
      lastSeenMtimeMs = anchored;
    } catch { /* tolerate; coherence check re-anchors on next read */ }
  } catch (err) {
    logBridgeError('bridge persist failed', err, { alwaysLog: true });
    throw err;
  }
}

/**
 * Best-effort variant of {@link persistBridgeDb}. Returns `{ ok: false }`
 * on failure instead of throwing. Reserve for callers where a missed
 * persist is genuinely acceptable (e.g. cache invalidation that the next
 * mutation will redo). Always-log policy still applies — write failures
 * cannot be silenced.
 */
export function tryPersistBridgeDb(
  db: any,
  dbPath?: string,
): { ok: true } | { ok: false; error: Error } {
  try {
    persistBridgeDb(db, dbPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
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
 * Bridge coherence check (story #1058 / epic #1054 — read-side symmetry to
 * #981 single-writer). sql.js holds an in-memory DB snapshot per process and
 * never re-reads disk after init, so any long-lived process — daemon or
 * not — returns stale rows when another writer has touched the file since
 * this process loaded its snapshot.
 *
 * Solution: stat the dbPath before every bridge op; if the mtime has advanced
 * past our last-known value, another writer has touched the file — drop the
 * bridge so `getRegistry` re-loads from disk on the next call.
 *
 * The daemon participates in this check too. #1058 originally exempted the
 * daemon under "daemon is the sole writer", but that assumption breaks every
 * session-start: `bin/index-guidance.mjs`, migration runners, and repair
 * tools all write directly to `.moflo/moflo.db` while the daemon is up
 * (epic #1057 calls these out as in-scope writers to coordinate). Without
 * the daemon doing the check, daemon-routed MCP reads served the pre-init
 * snapshot indefinitely, hiding the indexer's chunks from `memory_search` /
 * `memory_get_neighbors` until the daemon process restarted (#1073, smoke).
 *
 * Self-invalidation is still suppressed: `persistBridgeDb` anchors
 * `lastSeenMtimeMs` to the post-write mtime, so the daemon's own writes never
 * trip the reload. External writers — whose touches advance mtime past the
 * anchor — do.
 */
async function checkBridgeCoherence(dbPath: string | undefined): Promise<void> {
  // No registry yet → nothing to invalidate; first init will anchor the cursor.
  if (!registryPromise) return;
  const target = dbPath ? path.resolve(dbPath) : getDbPath();
  if (target === ':memory:') return;
  // Under WAL (Phase 5 / #1083), commits land in the `-wal` sidecar first —
  // the main DB file's mtime ONLY advances on checkpoint, which may be many
  // writes apart. Statting just the main file misses every external WAL
  // write between checkpoints, leaving the bridge with a stale in-memory
  // snapshot indefinitely. That's the failure mode in #1098 / #1073 smoke
  // where doctor's seed-via-openDaemonDatabase then bridge-via-MCP couldn't
  // see its own freshly-written rows. Stat both files and use whichever is
  // most recent. Mirrors the same fix in `refreshVectorStatsCache`.
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(target).mtimeMs;
  } catch {
    // File missing or unreadable — fall through. Downstream withDb surfaces
    // the error; we don't synthesize a coherence event from a stat failure.
    return;
  }
  try {
    const walStat = fs.statSync(`${target}-wal`);
    if (walStat.mtimeMs > mtimeMs) mtimeMs = walStat.mtimeMs;
  } catch { /* no WAL sidecar yet — main mtime is authoritative */ }
  if (lastSeenMtimeMs == null) {
    // First op after init — anchor and proceed.
    lastSeenMtimeMs = mtimeMs;
    return;
  }
  if (mtimeMs > lastSeenMtimeMs) {
    // Another process wrote since we loaded. Drop the bridge so the next
    // `getRegistry` call re-initializes from fresh disk. Reset the cursor;
    // the post-reload anchor (after `getRegistry` succeeds) re-sets it.
    await shutdownBridge();
    lastSeenMtimeMs = null;
  }
}

/**
 * Resolve registry + db, run fn, return null on any unexpected failure so
 * the caller falls back to raw sql.js. Errors are logged to stderr —
 * silently swallowing them previously masked real bugs in bridge-entries.ts.
 *
 * Bridge coherence (#1058): every entry through this gate checks whether the
 * dbPath's mtime has advanced past our last-known value; if so, the bridge is
 * torn down so the next op reads fresh disk state. Daemon participates in the
 * check; its own writes anchor `lastSeenMtimeMs` via `persistBridgeDb` so
 * self-fire is suppressed.
 */
export async function withDb<T>(
  dbPath: string | undefined,
  fn: (ctx: BridgeDbContext, registry: any) => Promise<T | null>,
): Promise<T | null> {
  return withDbInner(dbPath, fn, 0);
}

async function withDbInner<T>(
  dbPath: string | undefined,
  fn: (ctx: BridgeDbContext, registry: any) => Promise<T | null>,
  attempt: number,
): Promise<T | null> {
  await checkBridgeCoherence(dbPath);
  const registry = await getRegistry(dbPath);
  if (!registry) return null;
  const ctx = getDb(registry);
  if (!ctx) return null;
  // Anchor the coherence cursor to load-time disk state once the registry is
  // resolved. The post-init read of `mofloDb.database` reflects the bytes
  // that were on disk when `openSqlJsDatabase` ran; pin the matching mtime so
  // a subsequent unrelated process write triggers reload, not a self-fire.
  // Include `-wal` since WAL writes don't bump the main file mtime (#1098).
  const target = dbPath ? path.resolve(dbPath) : getDbPath();
  if (lastSeenMtimeMs == null && target !== ':memory:') {
    try {
      let anchor = fs.statSync(target).mtimeMs;
      try {
        const walStat = fs.statSync(`${target}-wal`);
        if (walStat.mtimeMs > anchor) anchor = walStat.mtimeMs;
      } catch { /* no WAL sidecar — main mtime is authoritative */ }
      lastSeenMtimeMs = anchor;
    } catch { /* file may not exist yet — first persist will anchor */ }
  }
  try {
    const result = await withBusyRetry(() => fn(ctx, registry));
    // Re-anchor the coherence cursor to the post-op mtime so internal
    // bridge writes that happen AFTER persistBridgeDb (attestation log,
    // bumpAccessCounts, cache invalidation row updates, etc.) don't
    // look like external writes on the next withDb call. Without this
    // re-anchor, the next call's checkBridgeCoherence sees the
    // attestation-advanced -wal mtime, tears down the registry, and
    // any test-injected stubs (cache.set, etc.) get reset — exactly
    // the failure mode in `bridge-entries.test.ts` #994 after the
    // WAL-coherence fix (49f91a01a). External writes still get
    // detected at the START of the next withDb call.
    if (target !== ':memory:') {
      try {
        let anchor = fs.statSync(target).mtimeMs;
        try {
          const walStat = fs.statSync(`${target}-wal`);
          if (walStat.mtimeMs > anchor) anchor = walStat.mtimeMs;
        } catch { /* no WAL sidecar */ }
        lastSeenMtimeMs = anchor;
      } catch { /* tolerate; coherence check re-anchors on next read */ }
    }
    return result;
  } catch (err) {
    // #1123 — stale-handle race: a concurrent withDb's coherence check tore
    // the registry down between our getDb() and fn() execution, closing the
    // underlying DatabaseSync. Drop the dead handle and retry once against a
    // freshly-acquired registry. The first attempt threw BEFORE its mutation
    // landed (node:sqlite errors at prepare/exec time, not mid-statement), so
    // a retry is idempotent. Bounded to one retry so a genuinely-unrecoverable
    // bridge (e.g. corrupt file, missing module) still surfaces as a null
    // return + logged error, not an infinite loop.
    if (attempt === 0 && isStaleHandleError(err)) {
      await shutdownBridge();
      return await withDbInner(dbPath, fn, attempt + 1);
    }
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
  // Drop the coherence cursor too — the next init will re-anchor against
  // whatever's on disk by then.
  lastSeenMtimeMs = null;
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
    // wrote the cache, running 3 COUNT queries is wasted work — skip the rest.
    //
    // Phase 4 (#1083) flipped the engine to node:sqlite + WAL: every commit
    // lands in the `-wal` sidecar (mtime advances there), not the main file.
    // Stat both so a write to either invalidates the cache. The `-shm` file
    // is not load-bearing — it tracks WAL readers, not committed writes.
    let dbMtimeMs = 0;
    let dbSizeKB = 0;
    try {
      const stat = fs.statSync(dbFile);
      dbMtimeMs = stat.mtimeMs;
      dbSizeKB = Math.floor(stat.size / 1024);
    } catch { /* file may not exist */ }
    try {
      const walStat = fs.statSync(`${dbFile}-wal`);
      if (walStat.mtimeMs > dbMtimeMs) dbMtimeMs = walStat.mtimeMs;
    } catch { /* no WAL sidecar — fine, dbMtimeMs already covers it */ }
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
