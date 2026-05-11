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
 *   - Never throws. Any error path returns `{ routed: false }`.
 *   - Returns within ≤100ms even if the daemon is dead/slow (HTTP timeout).
 *   - Caches daemon health for 5s to keep the hot path cheap.
 *   - Short-circuits without HTTP when:
 *       (a) `process.env.MOFLO_IS_DAEMON === '1'` (daemon's own process)
 *       (b) `moflo.yaml` has `daemon.auto_start: false`
 *
 * Naming note: the module is named `daemon-write-client` for compat with
 * existing importers, but as of #1058 it also covers reads.
 *
 * @module cli/memory/daemon-write-client
 */

import * as http from 'node:http';

// ============================================================================
// Constants
// ============================================================================

/** Default daemon HTTP port. Mirrors `DEFAULT_DASHBOARD_PORT` in daemon-dashboard.ts. */
const DEFAULT_DAEMON_PORT = 3117;

/** HTTP timeout for ALL daemon requests (probe + write). Bounds the worst-case CLI hang. */
const DAEMON_HTTP_TIMEOUT_MS = 100;

/** Health-probe cache TTL. Probe at most once per 5s in either direction. */
const HEALTH_CACHE_TTL_MS = 5_000;

// ============================================================================
// Public types
// ============================================================================

/**
 * Result of a daemon-routed write. `routed: false` means the caller MUST
 * fall back to its direct-write path (the daemon is unavailable or
 * disabled, OR we are inside the daemon process itself).
 */
export interface DaemonWriteResult {
  /** True iff the write was successfully delivered to the daemon (regardless of daemon's outcome). */
  routed: boolean;
  /** Set when routed=true: the daemon's response status. */
  ok?: boolean;
  /** Set on a successful store: the entry id the daemon assigned. */
  id?: string;
  /** Set on a successful delete: whether the row existed. */
  deleted?: boolean;
  /** Set on routed-but-failed: the daemon's error message. */
  error?: string;
}

/**
 * Result of a daemon-routed read (#1058). `routed: false` means fall back to
 * the local bridge / raw-sql.js path; `routed: true` means HTTP succeeded
 * and `data` carries the daemon's response payload (or `error` if the daemon
 * itself returned a 5xx with a structured error).
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
}

// ============================================================================
// Resolve daemon port (env override → moflo.yaml unused for v1 → default)
// ============================================================================

function getDaemonPort(): number {
  const fromEnv = process.env.MOFLO_DAEMON_PORT;
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_DAEMON_PORT;
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

/**
 * Cached daemon health probe. Returns true iff the daemon's HTTP server
 * is reachable on `127.0.0.1:<port>` within {@link DAEMON_HTTP_TIMEOUT_MS}.
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

  const available = await probeDaemonHealth(getDaemonPort());
  healthCache = { available, checkedAt: now };
  return available;
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
}): Promise<DaemonWriteResult> {
  if (!(await isDaemonAvailable())) return { routed: false };
  return postJson('/api/memory/store', {
    namespace: opts.namespace,
    key: opts.key,
    value: opts.value,
    tags: opts.tags,
    ttl: opts.ttl,
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

function postJson(path: string, body: unknown): Promise<DaemonWriteResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: DaemonWriteResult): void => {
      if (done) return;
      done = true;
      // On routed-failure, invalidate the health cache so the next call
      // re-probes and trips back to direct-write quickly when the daemon
      // is dying.
      if (result.routed === false) healthCache = null;
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
          // Status >=500 is a daemon-side fault; treat as unrouted so the
          // caller falls back. Status 4xx (validation) is ALSO unrouted —
          // we don't want a malformed payload silently lost just because
          // the HTTP delivery succeeded.
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            finish({ routed: false });
            return;
          }
          try {
            const data = JSON.parse(buf);
            finish({
              routed: true,
              ok: !!data?.ok,
              id: typeof data?.id === 'string' ? data.id : undefined,
              deleted: typeof data?.deleted === 'boolean' ? data.deleted : undefined,
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
      if (result.routed === false) healthCache = null;
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
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            finish({ routed: false });
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
