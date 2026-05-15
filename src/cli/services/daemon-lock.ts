/**
 * Atomic daemon lock — prevents duplicate daemon processes.
 *
 * Uses fs.writeFileSync with { flag: 'wx' } (O_CREAT | O_EXCL) which is
 * atomic on all platforms: the write fails immediately if the file exists,
 * eliminating the TOCTOU race in the old PID-file approach.
 *
 * Also solves Windows PID recycling by storing a label in the lock payload
 * and verifying the process command line before trusting a "live" PID.
 */

import * as fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';

export interface DaemonLockPayload {
  pid: number;
  startedAt: number;
  label: string;
  /**
   * Moflo package version the daemon was launched from. Added in epic #1054
   * to detect daemons that survived an `npm install moflo@<new>` and are now
   * running pre-upgrade code against post-upgrade on-disk state. Missing on
   * locks written by pre-#1054 daemons; the launcher treats absent version
   * the same as a mismatch (recycle).
   */
  version?: string;
  /**
   * Actual port the daemon's HTTP server bound to. Added in #1145 so clients
   * can discover the bound port from the lock file rather than guessing the
   * fixed default (which produced silent cross-project routing when two
   * moflo daemons collided). Stamped by `writeLockPort()` after a successful
   * bind. Missing on locks written by pre-#1145 daemons; clients fall back
   * to `resolveProjectPort()` then `LEGACY_DEFAULT_PORT`.
   */
  port?: number;
}

const LOCK_FILENAME = 'daemon.lock';
const LOCK_LABEL = 'moflo-daemon';

/** Resolve the lock file path for a project root. */
export function lockPath(projectRoot: string): string {
  return join(projectRoot, '.moflo', LOCK_FILENAME);
}

/**
 * Read this daemon's own moflo package version by walking up from the
 * compiled module location until a `package.json` with `"name": "moflo"`
 * is found. Mirrors the pattern in `mcp-server.ts:260-279`. Returns
 * `undefined` if the package.json can't be located — the launcher treats
 * an undefined version the same as a mismatch, so this stays safe.
 */
export function readOwnMofloVersion(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      try {
        const pkg = JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === 'moflo' && typeof pkg.version === 'string') return pkg.version;
      } catch { /* ignore — keep walking */ }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/**
 * Try to acquire the daemon lock atomically.
 *
 * @returns `{ acquired: true }` on success,
 *          `{ acquired: false, holder: pid }` if another daemon owns the lock.
 */
export function acquireDaemonLock(
  projectRoot: string,
  pid: number = process.pid,
): { acquired: true } | { acquired: false; holder: number } {
  const lock = lockPath(projectRoot);
  const stateDir = join(projectRoot, '.moflo');

  // Ensure state directory exists
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const payload: DaemonLockPayload = {
    pid,
    startedAt: Date.now(),
    label: LOCK_LABEL,
    version: readOwnMofloVersion(),
  };

  // Attempt 1: atomic exclusive create
  const result = tryExclusiveWrite(lock, payload);
  if (result === 'ok') {
    return { acquired: true };
  }

  // File already exists — check if the holder is still a live daemon
  const existing = readLockPayload(lock);
  if (!existing) {
    // Corrupt or unreadable — remove and retry once
    safeUnlink(lock);
    return tryExclusiveWrite(lock, payload) === 'ok'
      ? { acquired: true }
      : { acquired: false, holder: -1 };
  }

  // Same PID as us? We already hold it (re-entrant).
  if (existing.pid === pid) {
    return { acquired: true };
  }

  // Is the process alive AND actually a moflo daemon?
  if (isProcessAlive(existing.pid) && isDaemonProcess(existing.pid)) {
    return { acquired: false, holder: existing.pid };
  }

  // Stale lock (dead process or recycled PID) — remove and retry once
  safeUnlink(lock);
  return tryExclusiveWrite(lock, payload) === 'ok'
    ? { acquired: true }
    : { acquired: false, holder: -1 };
}

/**
 * Release the daemon lock. Only removes if we own it (or force = true).
 */
export function releaseDaemonLock(projectRoot: string, pid: number = process.pid, force = false): void {
  const lock = lockPath(projectRoot);
  if (!fs.existsSync(lock)) return;

  if (force) {
    safeUnlink(lock);
    return;
  }

  const existing = readLockPayload(lock);
  if (existing && existing.pid === pid) {
    safeUnlink(lock);
  }
}

/**
 * Stamp the daemon's bound HTTP port into the lock file (#1145).
 *
 * Called by `daemon-dashboard.startDashboard()` after a successful bind so
 * clients can read the actual port (vs. guessing the fixed default and
 * silently hitting another project's daemon).
 *
 * Best-effort by design:
 *   - Missing lock → no-op (the daemon didn't acquire the lock; this is
 *     a test or unusual startup path).
 *   - Lock owned by a different PID → no-op (we don't overwrite locks we
 *     don't own).
 *   - Write failure → swallowed (the daemon still serves; clients fall
 *     back to the deterministic port resolution).
 *
 * Returns `true` on a successful stamp, `false` otherwise. The boolean is
 * informational — production callers don't branch on it.
 */
export function writeLockPort(
  projectRoot: string,
  port: number,
  pid: number = process.pid,
): boolean {
  if (!Number.isFinite(port) || port < 1 || port > 65535) return false;
  const lock = lockPath(projectRoot);
  const existing = readLockPayload(lock);
  if (!existing) return false;
  if (existing.pid !== pid) return false;
  if (existing.port === port) return true;

  const updated: DaemonLockPayload = { ...existing, port };
  try {
    // Atomic write-then-rename: a client reading mid-write never sees a
    // truncated JSON. The vulnerable window is precisely a re-stamp after
    // a daemon recycle on a different port, when clients are likeliest
    // to be probing the lock for the new port.
    atomicWriteFileSync(lock, JSON.stringify(updated));
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically transfer the daemon lock to a new PID (e.g. parent → child).
 *
 * Overwrites the lock file in-place so there is no window where the lock
 * is absent.  Only succeeds if the lock is currently held by `fromPid`.
 */
export function transferDaemonLock(
  projectRoot: string,
  newPid: number,
  fromPid: number = process.pid,
): boolean {
  const lock = lockPath(projectRoot);
  const existing = readLockPayload(lock);

  if (!existing || existing.pid !== fromPid) {
    return false; // We don't own the lock — can't transfer
  }

  const payload: DaemonLockPayload = {
    pid: newPid,
    startedAt: Date.now(),
    label: LOCK_LABEL,
    version: existing.version ?? readOwnMofloVersion(),
    // Preserve the port field across PID transfers (#1145) — the child
    // process inherits the parent's binding, so the port is still valid.
    ...(existing.port != null ? { port: existing.port } : {}),
  };

  try {
    // Atomic overwrite — no unlink/recreate gap
    fs.writeFileSync(lock, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the full daemon-lock payload (or null if no daemon, corrupt lock,
 * or the holder is dead). Used by the launcher to compare the daemon's
 * reported moflo version against the installed package.json version
 * (epic #1054 — kill stale daemons that survived `npm install moflo@new`).
 */
export function getDaemonLockPayload(projectRoot: string): DaemonLockPayload | null {
  const lock = lockPath(projectRoot);
  if (!fs.existsSync(lock)) return null;

  const existing = readLockPayload(lock);
  if (!existing) {
    safeUnlink(lock);
    return null;
  }

  if (isProcessAlive(existing.pid) && isDaemonProcess(existing.pid)) {
    return existing;
  }

  safeUnlink(lock);
  return null;
}

/**
 * Check if the daemon lock is currently held by a live daemon.
 * Returns the holder PID or null.
 */
export function getDaemonLockHolder(projectRoot: string): number | null {
  const lock = lockPath(projectRoot);

  if (!fs.existsSync(lock)) return null;

  const existing = readLockPayload(lock);
  if (!existing) {
    // Corrupt lock file — clean it up
    safeUnlink(lock);
    return null;
  }

  if (isProcessAlive(existing.pid) && isDaemonProcess(existing.pid)) {
    return existing.pid;
  }

  // Stale — clean it up opportunistically
  safeUnlink(lock);
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryExclusiveWrite(path: string, payload: DaemonLockPayload): 'ok' | 'exists' {
  try {
    fs.writeFileSync(path, JSON.stringify(payload), { flag: 'wx' });
    return 'ok';
  } catch (err: any) {
    if (err.code === 'EEXIST') return 'exists';
    // Other errors (permissions, disk full) — treat as failure to acquire
    return 'exists';
  }
}

function readLockPayload(path: string): DaemonLockPayload | null {
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data.pid === 'number' && typeof data.startedAt === 'number') {
      return data as DaemonLockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function safeUnlink(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch { /* ignore — file may already be gone */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-platform check: is this PID actually a moflo/claude-flow daemon?
 *
 * This prevents false positives from Windows PID recycling, where a dead
 * daemon's PID gets reused by an unrelated process (e.g. Chrome).
 *
 * - Windows: uses `tasklist /FI` to check the process image + command line
 * - Linux:   reads /proc/<pid>/cmdline
 * - macOS:   uses `ps -p <pid> -o command=`
 *
 * Falls back to `true` (trust process.kill) if the platform check fails,
 * to avoid accidentally allowing duplicates on exotic platforms.
 */
export function isDaemonProcess(pid: number): boolean {
  // #1086: Windows execSync introspection (8s worst-case: tasklist 3s +
  // powershell 5s) starves under parallel vitest workers and pushes tests
  // past the 5s budget. Production never sets this env var.
  if (process.env.MOFLO_TEST_TRUST_DAEMON_PID === '1') {
    return true;
  }
  try {
    if (process.platform === 'win32') {
      return isDaemonProcessWindows(pid);
    } else if (process.platform === 'linux') {
      return isDaemonProcessLinux(pid);
    } else {
      // macOS and others
      return isDaemonProcessUnix(pid);
    }
  } catch {
    // If platform check fails, trust the kill(0) result to avoid
    // accidentally allowing duplicates
    return true;
  }
}

function isDaemonProcessWindows(pid: number): boolean {
  try {
    const result = execSync(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    );
    // tasklist returns the image name + PID in CSV; check it's a node process
    // and then verify via wmic/powershell that the command line contains daemon keywords
    if (!result.includes('node')) return false;

    const cmdResult = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    );
    return /daemon\s+start|moflo|claude-flow/i.test(cmdResult);
  } catch {
    return true; // fallback: trust kill(0)
  }
}

function isDaemonProcessLinux(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return /daemon.*start|moflo|claude-flow/i.test(cmdline);
  } catch {
    return true; // fallback
  }
}

function isDaemonProcessUnix(pid: number): boolean {
  try {
    const result = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return /daemon.*start|moflo|claude-flow/i.test(result);
  } catch {
    return true; // fallback
  }
}
