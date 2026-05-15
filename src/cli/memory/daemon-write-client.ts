/**
 * Daemon RPC client (#981 / #984 / #1058 — single-writer architecture and
 * its read-side symmetry).
 *
 * HTTP client for the `POST /api/memory/{store,delete,batch,get,search,list}`
 * RPC added by Stories #983 and #1058. Lets short-lived CLI processes and
 * the long-lived MCP server route their `.moflo/moflo.db` operations through
 * the daemon, which owns the authoritative sql.js handle. Avoids the
 * multi-process write clobber from #981 AND the stale read snapshot from
 * #1058 (sql.js never re-reads disk after init).
 *
 * Contract — every function in this module:
 *   - Never throws. Outcomes are reported via the result envelope.
 *   - Returns within ≤100ms even if the daemon is dead/slow (HTTP timeout).
 *   - Caches daemon health for 5s to keep the hot path cheap.
 *   - Short-circuits without HTTP when:
 *       (a) `process.env.MOFLO_IS_DAEMON === '1'` (daemon's own process)
 *       (b) `moflo.yaml` has `daemon.auto_start: false`
 *
 * Failure-shape contract (#1101 — surface 4xx as a real error):
 *   - 4xx response                 → `routed: true, ok: false, error: <msg>` (writes)
 *                                  → `routed: true, error: <msg>` (reads)
 *                                  → caller PROPAGATES the error; does NOT fall back.
 *   - 5xx, 503, timeout,           → `routed: false`
 *     ECONNREFUSED, malformed JSON,  → caller falls back to bridge-direct.
 *     socket destroyed mid-stream
 *
 * The 4xx codes only fire on daemon-side payload validation (see
 * daemon-memory-rpc.ts). Bridge-direct has the same validation and would
 * fail the same way — falling back silently loses the daemon's actionable
 * error message. 5xx and transport faults are transient/daemon-side bugs;
 * bridge-direct is the right next step.
 *
 * Naming note: the module is named `daemon-write-client` for compat with
 * existing importers, but as of #1058 it also covers reads.
 *
 * @module cli/memory/daemon-write-client
 */

import * as http from 'node:http';
import { findProjectRoot } from '../services/project-root.js';
import {
  resolveClientPort,
  LEGACY_DEFAULT_PORT,
  probeDaemonHealth as probeDaemonHealthIdentity,
  normalizeProjectRoot,
} from '../services/daemon-port.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Read-only legacy default exported for tests; the actual port comes from
 * `getDaemonPort()` which delegates to `resolveClientPort(findProjectRoot())`.
 * Routes through `LEGACY_DEFAULT_PORT` so no literal port number lives in
 * this file — see `daemon-port.ts` and the no-fixed-port regression guard.
 */
const DEFAULT_DAEMON_PORT = LEGACY_DEFAULT_PORT;

/** HTTP timeout for ALL daemon requests (probe + write). Bounds the worst-case CLI hang. */
const DAEMON_HTTP_TIMEOUT_MS = 100;

/** Health-probe cache TTL. Probe at most once per 5s in either direction. */
const HEALTH_CACHE_TTL_MS = 5_000;

// ============================================================================
// Public types
// ============================================================================

/**
 * Result of a daemon-routed write.
 *
 *   - `routed: false`                → daemon unreachable / transport fault /
 *                                      5xx / daemon-process short-circuit.
 *                                      Caller MUST fall back to direct write.
 *   - `routed: true,  ok: true`      → daemon accepted; `id` carries the entry id.
 *   - `routed: true,  ok: false`     → daemon REJECTED the payload (4xx
 *                                      validation). Caller MUST propagate
 *                                      `error` to the user and NOT fall back —
 *                                      bridge-direct has the same validation
 *                                      and will fail the same way (#1101).
 */
export interface DaemonWriteResult {
  /** True iff the daemon answered with a structured payload (2xx or 4xx). */
  routed: boolean;
  /** True on 2xx; false on 4xx (validation reject). Undefined when routed=false. */
  ok?: boolean;
  /** Set on a successful store: the entry id the daemon assigned. */
  id?: string;
  /** Set on a successful delete: whether the row existed. */
  deleted?: boolean;
  /**
   * Set on a successful store when the bridge embedded the row (#1065).
   * Mirrors `bridgeStoreEntry`'s return shape so the daemon-routed path
   * and the bridge-direct fallback are indistinguishable to callers.
   */
  embedding?: { dimensions: number; model: string };
  /** Set on routed-but-failed (4xx): the daemon's error message. */
  error?: string;
}

/**
 * Result of a daemon-routed read (#1058).
 *
 *   - `routed: false`                → daemon unreachable / transport fault /
 *                                      5xx / daemon-process short-circuit.
 *                                      Caller falls back to bridge / direct.
 *   - `routed: true,  data: ...`     → daemon answered 2xx; use `data`.
 *   - `routed: true,  error: ...`    → daemon REJECTED (4xx). Caller MUST
 *     (no `data`)                      propagate `error`, NOT fall back (#1101).
 */
export interface DaemonReadResult<T> {
  routed: boolean;
  data?: T;
  error?: string;
}

/** Shape returned by POST /api/memory/get when the row exists. */
export interface DaemonGetEntry {
  id: string;
  key: string;
  namespace: string;
  content: string;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  hasEmbedding: boolean;
  tags: string[];
  metadata?: string;
}

/** Shape returned by POST /api/memory/search per result. */
export interface DaemonSearchHit {
  id: string;
  key: string;
  content: string;
  score: number;
  namespace: string;
  metadata?: string;
}

/** Shape returned by POST /api/memory/list per entry. */
export interface DaemonListEntry {
  id: string;
  key: string;
  namespace: string;
  size: number;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  hasEmbedding: boolean;
}

// ============================================================================
// Module state — cached probes, never persisted
// ============================================================================

interface HealthCache { available: boolean; checkedAt: number; }

let healthCache: HealthCache | null = null;
let configCache: { daemonEnabled: boolean; checkedAt: number } | null = null;

/**
 * Test seam: clear all caches. Production callers never invoke this; tests
 * use it between cases so cached state doesn't leak across.
 */
export function _resetForTest(): void {
  healthCache = null;
  configCache = null;
  identityCache = null;
  _portCache = null;
  _identityWarnedFor.clear();
}

// ============================================================================
// Resolve daemon port (env override → moflo.yaml unused for v1 → default)
// ============================================================================

/**
 * Resolve the daemon HTTP port for this project.
 *
 * Delegates to `resolveClientPort(findProjectRoot())`:
 *   1. `MOFLO_DAEMON_PORT` env override (consumer pin)
 *   2. `port` field in `<projectRoot>/.moflo/daemon.lock` (server records
 *      the actual bound port after startup — #1145)
 *   3. Deterministic per-project port `33000 + sha256(path)%1000`
 *
 * Cached per-process — the lock-file path doesn't change once a process is
 * up. On a routed-failure the health cache is invalidated (which triggers
 * the next port resolve), keeping the client honest about daemon location
 * after a recycle.
 */
let _portCache: { port: number; projectRoot: string } | null = null;

function getDaemonPort(): number {
  const projectRoot = findProjectRoot();
  if (_portCache && _portCache.projectRoot === projectRoot) return _portCache.port;
  const port = resolveClientPort(projectRoot);
  _portCache = { port, projectRoot };
  return port;
}

// ============================================================================
// Daemon-disabled check (cached) — reads `daemon.auto_start` from moflo.yaml
// ============================================================================

async function isDaemonEnabledInConfig(): Promise<boolean> {
  const now = Date.now();
  if (configCache && (now - configCache.checkedAt) < HEALTH_CACHE_TTL_MS) {
    return configCache.daemonEnabled;
  }
  let enabled = true; // default-on — matches moflo.yaml default
  try {
    const { loadMofloConfig } = await import('../config/moflo-config.js');
    const config = loadMofloConfig();
    enabled = config?.daemon?.auto_start !== false;
  } catch {
    // If we can't read the config (e.g., not in a moflo project), assume
    // daemon-enabled — we'll still probe and the probe will fail safely.
    enabled = true;
  }
  configCache = { daemonEnabled: enabled, checkedAt: now };
  return enabled;
}

// ============================================================================
// Health probe (cached) — GET /api/status
// ============================================================================

// ============================================================================
// Identity check (#1145) — refuse to route to a daemon owning a different
// project. Before this, the client trusted any daemon on the resolved port.
// ============================================================================

interface IdentityCache {
  matches: boolean;
  checkedAt: number;
  /** What the daemon reported. Used in the stderr warn on mismatch. */
  daemonProjectRoot?: string;
  /** What we expected. Used in the stderr warn on mismatch. */
  ourProjectRoot: string;
}

let identityCache: IdentityCache | null = null;

/**
 * Ports we've already warned about during this process — bounded by the
 * number of distinct daemon ports a single client process can see in its
 * lifetime (usually 1). Keeps the stderr noise to a single line per
 * mismatched daemon per process.
 */
const _identityWarnedFor = new Set<number>();

/**
 * Cached daemon health probe. Returns true iff the daemon's HTTP server
 * is reachable on `127.0.0.1:<port>` within {@link DAEMON_HTTP_TIMEOUT_MS}
 * AND its `/api/health` reports a `projectRoot` matching ours (#1145).
 *
 * Cache survives 5s in either direction — so a daemon that just came up
 * is missed for ≤5s, and a daemon that just died is incorrectly assumed
 * up for ≤5s. Caller falls back to direct write either way.
 */
export async function isDaemonAvailable(): Promise<boolean> {
  // 1) In-daemon short-circuit — never probe ourselves.
  if (process.env.MOFLO_IS_DAEMON === '1') return false;

  // 2) Config short-circuit — daemon explicitly disabled.
  if (!(await isDaemonEnabledInConfig())) return false;

  // 3) Cached probe.
  const now = Date.now();
  if (healthCache && (now - healthCache.checkedAt) < HEALTH_CACHE_TTL_MS) {
    return healthCache.available;
  }

  const port = getDaemonPort();
  const reachable = await probeDaemonHealth(port);
  if (!reachable) {
    healthCache = { available: false, checkedAt: now };
    return false;
  }

  // 4) Identity check — daemon reachable but is it OUR daemon?
  const identityOk = await isDaemonIdentityMatch(port);
  healthCache = { available: identityOk, checkedAt: now };
  return identityOk;
}

/**
 * Probe `/api/health` and confirm the daemon's reported `projectRoot`
 * matches ours. Caches the result for {@link HEALTH_CACHE_TTL_MS}.
 *
 * Mismatch consequence: this function returns `false`, the caller falls
 * through to the direct-SQL path (the path that is provably correct, see
 * the `MOFLO_DISABLE_DAEMON_ROUTING=1` reproducer in
 * `docs/internal/1145-daemon-port-collision-analysis.md`), and we emit
 * ONE stderr line per port per process so the user can see the wrong-
 * project daemon is the problem.
 *
 * Tolerant of legacy daemons that don't expose `/api/health`: a 404 means
 * the daemon predates #1145, so we trust the legacy port resolution (the
 * client is presumably hitting the same project's daemon anyway) and
 * return `true`. The lock-file port-discovery path is the primary
 * collision defence; identity check is the safety net.
 */
async function isDaemonIdentityMatch(port: number): Promise<boolean> {
  const now = Date.now();
  const ourProjectRoot = findProjectRoot();

  if (
    identityCache &&
    identityCache.ourProjectRoot === ourProjectRoot &&
    (now - identityCache.checkedAt) < HEALTH_CACHE_TTL_MS
  ) {
    return identityCache.matches;
  }

  const probe = await probeDaemonHealthIdentity(port, DAEMON_HTTP_TIMEOUT_MS);
  if (probe.kind === 'legacy' || probe.kind === 'unreachable') {
    // No identity to compare — daemon either predates #1145 or the probe
    // itself failed transport-side. Fall open: rely on port-discovery
    // (lock file + deterministic hash) as the primary defence. Only a
    // CONFIRMED mismatch blocks routing — that's the conservative safety
    // net that doesn't break upgraded-client-against-legacy-daemon.
    //
    // Asymmetry with doctor's `checkDaemonIdentity`: the healer probes
    // LEGACY_DEFAULT_PORT explicitly and flags a foreign legacy daemon
    // as `fail`, while this hot path lets it through. That's intentional
    // — the doctor runs on-demand for diagnostics, and live writes must
    // not block when the cluster is mid-upgrade. The CHANGELOG migration
    // window is the agreed remediation surface.
    identityCache = { matches: true, checkedAt: now, ourProjectRoot };
    return true;
  }

  const matches = normalizeProjectRoot(probe.projectRoot) === normalizeProjectRoot(ourProjectRoot);
  identityCache = {
    matches,
    checkedAt: now,
    ourProjectRoot,
    daemonProjectRoot: probe.projectRoot,
  };

  if (!matches && !_identityWarnedFor.has(port)) {
    _identityWarnedFor.add(port);
    // One stderr line per mismatched daemon, ever. Quiet enough that scripts
    // don't drown but loud enough that healer-class diagnostics surface it.
    process.stderr.write(
      `[moflo] daemon at 127.0.0.1:${port} claims project '${probe.projectRoot}' but cwd is '${ourProjectRoot}' — ` +
      `using direct DB. Run flo healer --fix to repair daemon binding (#1145).\n`,
    );
  }

  return matches;
}

function probeDaemonHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/status', timeout: DAEMON_HTTP_TIMEOUT_MS },
      (res) => {
        // Discard body; status code is enough.
        res.resume();
        finish(res.statusCode === 200);
      },
    );
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
  });
}

// ============================================================================
// Write helpers — POST /api/memory/{store,delete}
// ============================================================================

/**
 * Route a single store write through the daemon. Returns
 * `{ routed: false }` if the daemon is unavailable, the env disables
 * routing, or any HTTP error fires.
 */
export async function tryDaemonStore(opts: {
  namespace: string;
  key: string;
  value: unknown;
  tags?: string[];
  ttl?: number;
  /** Per-row metadata forwarded to the daemon's `metadata` column (#1064). */
  metadata?: Record<string, unknown> | string;
}): Promise<DaemonWriteResult> {
  if (!(await isDaemonAvailable())) return { routed: false };
  return postJson('/api/memory/store', {
    namespace: opts.namespace,
    key: opts.key,
    value: opts.value,
    tags: opts.tags,
    ttl: opts.ttl,
    metadata: opts.metadata,
  });
}

/**
 * Route a single delete through the daemon. Returns `{ routed: false }`
 * on any failure mode.
 */
export async function tryDaemonDelete(opts: {
  namespace: string;
  key: string;
}): Promise<DaemonWriteResult> {
  if (!(await isDaemonAvailable())) return { routed: false };
  return postJson('/api/memory/delete', {
    namespace: opts.namespace,
    key: opts.key,
  });
}

/**
 * Route a single-entry retrieve through the daemon (#1058). Returns
 * `{ routed: false }` if the daemon is unavailable; otherwise
 * `{ routed: true, data: { found, entry? } }`. The `entry` field is the
 * same shape as `getEntry`'s in-process return.
 */
export async function tryDaemonGet(opts: {
  namespace: string;
  key: string;
}): Promise<DaemonReadResult<{ found: boolean; entry?: DaemonGetEntry }>> {
  if (!(await isDaemonAvailable())) return { routed: false };
  return postReadJson<{ found: boolean; entry?: DaemonGetEntry }>(
    '/api/memory/get',
    { namespace: opts.namespace, key: opts.key },
    (data) => ({
      found: !!data?.found,
      entry: data?.entry as DaemonGetEntry | undefined,
    }),
  );
}

/**
 * Route a semantic search through the daemon (#1058).
 */
export async function tryDaemonSearch(opts: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
}): Promise<DaemonReadResult<{ results: DaemonSearchHit[]; searchTime?: number }>> {
  if (!(await isDaemonAvailable())) return { routed: false };
  return postReadJson<{ results: DaemonSearchHit[]; searchTime?: number }>(
    '/api/memory/search',
    {
      query: opts.query,
      namespace: opts.namespace,
      limit: opts.limit,
      threshold: opts.threshold,
    },
    (data) => ({
      results: Array.isArray(data?.results) ? (data.results as DaemonSearchHit[]) : [],
      searchTime: typeof data?.searchTime === 'number' ? data.searchTime : undefined,
    }),
  );
}

/**
 * Route a paginated list through the daemon (#1058).
 */
export async function tryDaemonList(opts: {
  namespace?: string;
  limit?: number;
  offset?: number;
}): Promise<DaemonReadResult<{ entries: DaemonListEntry[]; total: number }>> {
  if (!(await isDaemonAvailable())) return { routed: false };
  return postReadJson<{ entries: DaemonListEntry[]; total: number }>(
    '/api/memory/list',
    {
      namespace: opts.namespace,
      limit: opts.limit,
      offset: opts.offset,
    },
    (data) => ({
      entries: Array.isArray(data?.entries) ? (data.entries as DaemonListEntry[]) : [],
      total: typeof data?.total === 'number' ? data.total : 0,
    }),
  );
}

// ============================================================================
// Internal HTTP poster — never throws, bounded timeout
// ============================================================================

/**
 * Extract a human-readable error message from a daemon 4xx response body.
 * Prefers `message` (the daemon's specific reason — e.g. "invalid namespace"),
 * falls back to `error` (the daemon's error category), then to a generic
 * status-code string when the body is non-JSON.
 */
function parse4xxError(buf: string, status: number): string {
  try {
    const data = JSON.parse(buf);
    const detail = typeof data?.message === 'string' ? data.message
      : typeof data?.error === 'string' ? data.error
      : undefined;
    if (detail) return detail;
  } catch {
    // Non-JSON 4xx body — fall through to the generic message.
  }
  return `daemon returned ${status}`;
}

/**
 * Narrow a parsed JSON value to the `{ dimensions, model }` embedding-response
 * shape (#1065). Returns `undefined` when the field is missing or malformed —
 * a malformed field is treated as "no embedding info" rather than failing the
 * whole response, so an older daemon that hasn't been updated still works.
 */
function parseEmbeddingField(value: unknown): { dimensions: number; model: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { dimensions?: unknown; model?: unknown };
  if (typeof v.dimensions !== 'number' || !Number.isFinite(v.dimensions)) return undefined;
  if (typeof v.model !== 'string' || v.model.length === 0) return undefined;
  return { dimensions: v.dimensions, model: v.model };
}

function postJson(path: string, body: unknown): Promise<DaemonWriteResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: DaemonWriteResult): void => {
      if (done) return;
      done = true;
      // On routed-failure, invalidate the health cache so the next call
      // re-probes and trips back to direct-write quickly when the daemon
      // is dying.
      if (result.routed === false) {
        // Daemon recycled to a different port (post #1145 server restart)
        // → invalidate the port cache too so the next call re-reads
        // .moflo/daemon.lock. Otherwise we'd keep hammering a stale port.
        healthCache = null;
        identityCache = null;
        _portCache = null;
      }
      resolve(result);
    };

    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: getDaemonPort(),
        path,
        method: 'POST',
        timeout: DAEMON_HTTP_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { buf += chunk; });
        res.on('end', () => {
          // #1101 — per-shape failure contract:
          //   2xx  → routed:true,  ok:true   (caller uses data)
          //   4xx  → routed:true,  ok:false  (caller propagates daemon error)
          //   5xx  → routed:false           (caller falls back to bridge)
          //   parse fail → routed:false (fall back)
          const status = res.statusCode ?? 0;
          if (status >= 500 || status < 200) {
            finish({ routed: false });
            return;
          }
          if (status >= 400) {
            // Daemon validated the payload and rejected it. Bridge-direct
            // has the same validation; falling back loses the actionable
            // error. Surface it to the caller instead.
            finish({ routed: true, ok: false, error: parse4xxError(buf, status) });
            return;
          }
          try {
            const data = JSON.parse(buf);
            finish({
              routed: true,
              ok: !!data?.ok,
              id: typeof data?.id === 'string' ? data.id : undefined,
              deleted: typeof data?.deleted === 'boolean' ? data.deleted : undefined,
              embedding: parseEmbeddingField(data?.embedding),
              error: typeof data?.error === 'string' ? data.error : undefined,
            });
          } catch {
            finish({ routed: false });
          }
        });
        res.on('error', () => finish({ routed: false }));
      },
    );
    req.on('error', () => finish({ routed: false }));
    req.on('timeout', () => { req.destroy(); finish({ routed: false }); });
    req.write(payload);
    req.end();
  });
}

/**
 * Generic JSON POST that returns a daemon-read envelope. Same transport
 * guarantees as `postJson`: never throws, bounded timeout, invalidates health
 * cache on routed-failure.
 *
 * The `shape` callback maps the daemon's parsed JSON payload to the typed
 * data shape the caller expects. Returning `null` from `shape` (or a parse
 * failure) downgrades to `{ routed: false }` so the caller falls back.
 */
function postReadJson<T>(
  path: string,
  body: unknown,
  shape: (data: any) => T | null,
): Promise<DaemonReadResult<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: DaemonReadResult<T>): void => {
      if (done) return;
      done = true;
      if (result.routed === false) {
        // Daemon recycled to a different port (post #1145 server restart)
        // → invalidate the port cache too so the next call re-reads
        // .moflo/daemon.lock. Otherwise we'd keep hammering a stale port.
        healthCache = null;
        identityCache = null;
        _portCache = null;
      }
      resolve(result);
    };

    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: getDaemonPort(),
        path,
        method: 'POST',
        timeout: DAEMON_HTTP_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { buf += chunk; });
        res.on('end', () => {
          // #1101 — mirror postJson contract for reads:
          //   2xx  → routed:true with shaped data
          //   4xx  → routed:true with error (no data) — caller propagates
          //   5xx  → routed:false (caller falls back)
          const status = res.statusCode ?? 0;
          if (status >= 500 || status < 200) {
            finish({ routed: false });
            return;
          }
          if (status >= 400) {
            finish({ routed: true, error: parse4xxError(buf, status) });
            return;
          }
          try {
            const parsed = JSON.parse(buf);
            const shaped = shape(parsed);
            if (shaped === null) {
              finish({ routed: false });
              return;
            }
            finish({ routed: true, data: shaped });
          } catch {
            finish({ routed: false });
          }
        });
        res.on('error', () => finish({ routed: false }));
      },
    );
    req.on('error', () => finish({ routed: false }));
    req.on('timeout', () => { req.destroy(); finish({ routed: false }); });
    req.write(payload);
    req.end();
  });
}
