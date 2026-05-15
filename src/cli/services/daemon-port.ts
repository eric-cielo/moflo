/**
 * Daemon port resolution — single source of truth for the moflo daemon's
 * HTTP port.
 *
 * Before #1145, `DEFAULT_DASHBOARD_PORT` in `daemon-dashboard.ts` and
 * `DEFAULT_DAEMON_PORT` in `daemon-write-client.ts` were two separate `3117`
 * literals. The server tried 3117 → 3126 on `EADDRINUSE`; the client always
 * POSTed to 3117. When a second moflo project's daemon bound 3118+, that
 * project's clients still hit 3117 → silent cross-project read/write
 * routing. See `docs/internal/1145-daemon-port-collision-analysis.md`.
 *
 * This module collapses both literals into one resolver. Every entry point
 * MUST go through `resolveProjectPort()` (or read the `port` field a
 * already-bound daemon recorded in `.moflo/daemon.lock`).
 *
 * Resolution precedence — server and client agree:
 *   1. `MOFLO_DAEMON_PORT` env override (consumer pin / smoke harness — wins)
 *   2. Lock-file `port` field (client-only — server WRITES this after bind)
 *   3. `resolveProjectPort(projectRoot)` — sha256(path) → 33000+(hash%1000)
 *   4. `LEGACY_DEFAULT_PORT` (3117) — read-only fallback for ancient locks
 *      with no port field and no env override; warns once via stderr
 *
 * @module cli/services/daemon-port
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as http from 'node:http';

/**
 * Deterministic port range. 33000-33999 — clear of every common dev-server
 * port (3000, 3001, 4000, 5000, 5173, 8000, 8080), every well-known service
 * (≤ 1024), and the moflo legacy default (3117). Collision probability across
 * N active projects is ~N/1000; the identity check (`isDaemonIdentityMatch`)
 * is the safety net when collisions do hit.
 */
export const PORT_RANGE_BASE = 33000;
export const PORT_RANGE_SIZE = 1000;

/**
 * Legacy default port — used by daemons that haven't been upgraded past
 * 4.10.7 and locks that never recorded a port field. Kept as a read-only
 * fallback so a fresh client probing an old daemon still finds it; clients
 * that fall through to this path emit a one-time deprecation warn.
 *
 * NEW code must NEVER reference this constant outside `daemon-port.ts`. The
 * regression guard at `tests/system/no-fixed-3117.test.ts` enforces.
 */
export const LEGACY_DEFAULT_PORT = 3117;

/**
 * Resolve the canonical port for a given project root.
 *
 * Pure function — no I/O. Same project path → same port across daemon
 * restarts, across processes, across machines (the hash is deterministic).
 *
 * @param projectRoot absolute path to the project root (use `findProjectRoot()`)
 * @returns port in `[PORT_RANGE_BASE, PORT_RANGE_BASE + PORT_RANGE_SIZE)`
 */
export function resolveProjectPort(projectRoot: string): number {
  const envPort = readEnvPortOverride();
  if (envPort != null) return envPort;
  const hash = createHash('sha256').update(projectRoot).digest();
  return PORT_RANGE_BASE + (hash.readUInt16BE(0) % PORT_RANGE_SIZE);
}

/**
 * Read `MOFLO_DAEMON_PORT` from the environment. Returns the parsed port
 * (1-65535) or `null` if unset/invalid.
 *
 * Exported so callers can short-circuit lock-file reads when the env is
 * pinned — useful in the smoke harness and CI where the env is the
 * authoritative pin.
 */
export function readEnvPortOverride(): number | null {
  const raw = process.env.MOFLO_DAEMON_PORT;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * Lock-file payload subset relevant to port resolution. Mirrors
 * `DaemonLockPayload` in `daemon-lock.ts` without importing it (this module
 * is loaded from `bin/` JS twins; avoid the TS-only import cycle).
 */
interface LockPortShape {
  port?: number;
  pid?: number;
}

/**
 * Resolve the daemon port a CLIENT should connect to for a given project.
 *
 * Reads `.moflo/daemon.lock` to discover the actual bound port — if the
 * daemon collided with another project in its deterministic-range bucket
 * and the dashboard retry loop bumped it forward, the lock reflects reality
 * and the client follows. Falls back to `resolveProjectPort` when the lock
 * is absent (daemon not yet started), the lock has no `port` field (old
 * daemon predating #1145), or the port reads as invalid.
 *
 * Never throws — every I/O failure degrades to the deterministic fallback.
 */
export function resolveClientPort(projectRoot: string): number {
  const envPort = readEnvPortOverride();
  if (envPort != null) return envPort;

  try {
    const lockFile = join(projectRoot, '.moflo', 'daemon.lock');
    if (existsSync(lockFile)) {
      const raw = readFileSync(lockFile, 'utf-8');
      const lock = JSON.parse(raw) as LockPortShape;
      const lockPort = typeof lock?.port === 'number' ? lock.port : null;
      if (lockPort && Number.isFinite(lockPort) && lockPort > 0 && lockPort < 65536) {
        return lockPort;
      }
    }
  } catch {
    // Corrupt or unreadable lock — fall through to deterministic port.
  }

  return resolveProjectPort(projectRoot);
}

/**
 * Build the list of ports the SERVER should try, in order, when starting
 * the daemon. First entry is the deterministic port; the rest are the
 * collision-fallback range. Capped at `PORT_RANGE_SIZE` so the loop can
 * never wrap past the bucket.
 *
 * If the env override is set, the list collapses to that single port —
 * the consumer pinned it on purpose; respect their choice and hard-fail
 * if it's already in use.
 */
export function serverPortCandidates(projectRoot: string, maxAttempts = 10): number[] {
  const envPort = readEnvPortOverride();
  if (envPort != null) return [envPort];

  const base = resolveProjectPort(projectRoot);
  const attempts = Math.min(Math.max(1, maxAttempts), PORT_RANGE_SIZE);
  const ports: number[] = [];
  for (let i = 0; i < attempts; i++) {
    ports.push(PORT_RANGE_BASE + ((base - PORT_RANGE_BASE + i) % PORT_RANGE_SIZE));
  }
  return ports;
}

// ============================================================================
// Identity probe — shared by client + healer (#1145)
// ============================================================================

/**
 * Normalize project root paths for identity comparison.
 *
 *   - Resolve symlinks via `realpathSync`. macOS aliases `/var/folders`
 *     → `/private/var/folders`; one side of the daemon/client pair may
 *     resolve the symlink and the other may not, producing false-positive
 *     identity mismatches on otherwise-matching project roots (caught by
 *     the consumer-smoke harness on macOS + Ubuntu after the original
 *     #1145 fix). Ubuntu hits the same shape via `/tmp` symlinks under
 *     certain mount configurations.
 *   - Lowercase on Windows so `C:\Users\...` and `c:\users\...` compare
 *     equal. POSIX is case-sensitive — pass through.
 *
 * Never throws — a path that doesn't exist (or that we lack permission
 * to stat) falls back to the input string. The fallback case is safe
 * because the symlink-mismatch class only fires on paths that DO exist
 * (both daemon and client just resolved them).
 */
export function normalizeProjectRoot(p: string): string {
  let resolved = p;
  try { resolved = realpathSync(p); } catch { /* path doesn't exist / EACCES — use input */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Result of probing a daemon's `/api/health` endpoint.
 *
 *   - `{ kind: 'identity', projectRoot }` — daemon answered with a project
 *     root the caller should compare against its own `findProjectRoot()`.
 *   - `{ kind: 'legacy' }` — daemon predates #1145 (404 on `/api/health`)
 *     OR answered 200 but without a recognisable identity field. Caller
 *     should fall through to port-based discovery (the primary defence).
 *   - `{ kind: 'unreachable' }` — transport error / timeout. Caller's
 *     reachability layer already established the daemon's liveness; this
 *     means identity is unknowable, not that the daemon is down.
 */
export type DaemonIdentityProbe =
  | { kind: 'identity'; projectRoot: string }
  | { kind: 'legacy' }
  | { kind: 'unreachable' };

/**
 * Send `GET /api/health` to `127.0.0.1:<port>` and parse the daemon's
 * identity payload. Never throws — every failure mode maps to a
 * `DaemonIdentityProbe` variant.
 *
 * Shared by `daemon-write-client.ts` (per-request safety net) and
 * `doctor-checks-config.ts` (`checkDaemonIdentity` subcheck).
 */
export function probeDaemonHealth(
  port: number,
  timeoutMs: number,
): Promise<DaemonIdentityProbe> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DaemonIdentityProbe): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status === 404) {
          res.resume();
          finish({ kind: 'legacy' });
          return;
        }
        if (status !== 200) {
          res.resume();
          finish({ kind: 'unreachable' });
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { buf += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(buf);
            if (typeof data?.projectRoot === 'string' && data.projectRoot.length > 0) {
              finish({ kind: 'identity', projectRoot: data.projectRoot });
              return;
            }
            // 200 but no identity field — pre-#1145 daemon that 200s on
            // every URL. Same handling as a 404.
            finish({ kind: 'legacy' });
          } catch {
            finish({ kind: 'legacy' });
          }
        });
        res.on('error', () => finish({ kind: 'unreachable' }));
      },
    );
    req.on('error', () => finish({ kind: 'unreachable' }));
    req.on('timeout', () => { req.destroy(); finish({ kind: 'unreachable' }); });
  });
}
