/**
 * Daemon write client (#981 / #984 — single-writer architecture).
 *
 * HTTP client for the `POST /api/memory/{store,delete,batch}` RPC added by
 * Story #983. Lets short-lived CLI processes and the long-lived MCP server
 * route their `.moflo/moflo.db` writes through the daemon, which owns the
 * authoritative sql.js handle. Avoids the multi-process clobber from #981.
 *
 * Contract — every function in this module:
 *   - Never throws. Any error path returns `{ routed: false }`.
 *   - Returns within ≤100ms even if the daemon is dead/slow (HTTP timeout).
 *   - Caches daemon health for 5s to keep the hot write path cheap.
 *   - Short-circuits without HTTP when:
 *       (a) `process.env.MOFLO_IS_DAEMON === '1'` (daemon's own process)
 *       (b) `moflo.yaml` has `daemon.auto_start: false`
 *
 * Story #984 ships the client without any consumer wiring — Story #985 / #986
 * add the routing preamble inside `storeEntry` / `deleteEntry` (see
 * `docs/internal/981-writer-audit.md`).
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
