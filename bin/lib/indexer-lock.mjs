/**
 * Indexer-lock helper (#1061 — cross-process write race: indexer chain vs daemon).
 *
 * The session-start indexer chain (bin/index-all.mjs) and the daemon both
 * write to `.moflo/moflo.db` via sql.js whole-file flush. If the daemon
 * performs any write during the seconds-to-minutes the chain runs, its next
 * flush clobbers the indexer's on-disk state with the daemon's stale in-RAM
 * snapshot.
 *
 * Fix: the indexer chain writes `.moflo/indexer.lock` at startup and removes
 * it at exit. Daemon-start (in bin/hooks.mjs) waits for the lock to clear
 * before forking — the indexer chain itself spawns the daemon at the end, so
 * the daemon comes up against a stable on-disk state.
 *
 * Stale-lock detection: a lock whose `pid` is no longer alive OR whose
 * mtime is older than MAX_LOCK_AGE_MS is treated as cleared. This guards
 * against indexer crashes that skip the release path.
 *
 * Contract — every function in this module:
 *   - Never throws. FS errors degrade gracefully (return false from
 *     acquire/release, treat lock as not-held from isHeld).
 *   - Returns synchronously.
 *
 * @module bin/lib/indexer-lock
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LOCK_FILENAME = 'indexer.lock';

/** Max age before a lock is treated as stale (10 min — covers cold-install indexer + slack). */
const MAX_LOCK_AGE_MS = 10 * 60 * 1000;

export function indexerLockPath(projectRoot) {
  return join(projectRoot, '.moflo', LOCK_FILENAME);
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but we lack permission to signal it — still
    // counts as "alive". ESRCH means it's truly gone.
    return err && err.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* malformed — treat as absent */ }
  return null;
}

/**
 * Returns true iff the lockfile exists, its recorded pid is alive (or
 * EPERM-protected), AND its mtime is within MAX_LOCK_AGE_MS. Anything else
 * is "not held" — caller may proceed.
 */
export function isIndexerLockHeld(projectRoot) {
  const lockPath = indexerLockPath(projectRoot);
  if (!existsSync(lockPath)) return false;

  let mtime;
  try { mtime = statSync(lockPath).mtimeMs; }
  catch { return false; }
  if (Date.now() - mtime > MAX_LOCK_AGE_MS) return false;

  const lock = readLock(lockPath);
  if (!lock) return false;
  return isPidAlive(lock.pid);
}

/**
 * Acquire the lock for this process. Returns true on success, false if
 * another live indexer holds it. Stale locks (dead pid or old mtime) are
 * silently overwritten.
 *
 * FS errors are non-fatal — returns true so the indexer chain still runs
 * even if .moflo/ is unwritable; the indexer's own writes will then fail
 * loudly with a clearer error than "lock acquire failed".
 */
export function acquireIndexerLock(projectRoot) {
  const lockPath = indexerLockPath(projectRoot);
  try {
    if (isIndexerLockHeld(projectRoot)) {
      // Another live indexer is running — bail.
      return false;
    }
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));
    return true;
  } catch {
    return true;
  }
}

/**
 * Release the lock IF this process owns it. Mismatched-pid locks are not
 * touched (someone else owns them). Missing lock is a no-op.
 *
 * Safe to call multiple times (exit + signal handlers both call it).
 */
export function releaseIndexerLock(projectRoot) {
  const lockPath = indexerLockPath(projectRoot);
  try {
    if (!existsSync(lockPath)) return;
    const lock = readLock(lockPath);
    if (lock && typeof lock.pid === 'number' && lock.pid !== process.pid) {
      // Another process holds it now — don't touch.
      return;
    }
    unlinkSync(lockPath);
  } catch { /* already gone or unreadable */ }
}
