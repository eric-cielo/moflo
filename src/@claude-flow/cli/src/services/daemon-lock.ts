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
import { join } from 'path';
import { execSync } from 'child_process';

export interface DaemonLockPayload {
  pid: number;
  startedAt: number;
  label: string;
}

const LOCK_FILENAME = 'daemon.lock';
const LOCK_LABEL = 'moflo-daemon';

/** Resolve the lock file path for a project root. */
export function lockPath(projectRoot: string): string {
  return join(projectRoot, '.claude-flow', LOCK_FILENAME);
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
  const stateDir = join(projectRoot, '.claude-flow');

  // Ensure state directory exists
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const payload: DaemonLockPayload = {
    pid,
    startedAt: Date.now(),
    label: LOCK_LABEL,
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
