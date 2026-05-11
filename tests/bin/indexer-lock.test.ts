/**
 * Unit tests for bin/lib/indexer-lock.mjs (#1061 — cross-process write race:
 * indexer chain vs daemon).
 *
 * Contract under test:
 *   - acquireIndexerLock writes a {pid, startedAt} JSON file.
 *   - releaseIndexerLock removes the lockfile if (and only if) we own it.
 *   - isIndexerLockHeld returns true ONLY when the file exists AND its
 *     recorded pid is alive AND its mtime is within 10 minutes.
 *   - Stale locks (dead pid OR old mtime) are treated as cleared, and a
 *     fresh acquire overwrites them.
 *   - All helpers are non-throwing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
  acquireIndexerLock,
  releaseIndexerLock,
  isIndexerLockHeld,
  indexerLockPath,
  // @ts-expect-error — pure JS module, no ambient types
} from '../../bin/lib/indexer-lock.mjs';

const TMP_ROOT = resolve(tmpdir(), 'moflo-indexer-lock-test-' + Date.now());

let projectRoot: string;

beforeEach(() => {
  projectRoot = resolve(TMP_ROOT, `proj-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(projectRoot, '.moflo'), { recursive: true });
});

afterEach(() => {
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('acquireIndexerLock', () => {
  it('writes a lockfile with our pid and startedAt timestamp', () => {
    const ok = acquireIndexerLock(projectRoot);
    expect(ok).toBe(true);

    const lockPath = indexerLockPath(projectRoot);
    expect(existsSync(lockPath)).toBe(true);

    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.startedAt).toBe('string');
    expect(new Date(lock.startedAt).toString()).not.toBe('Invalid Date');
  });

  it('creates the .moflo/ directory if missing', () => {
    rmSync(join(projectRoot, '.moflo'), { recursive: true, force: true });
    const ok = acquireIndexerLock(projectRoot);
    expect(ok).toBe(true);
    expect(existsSync(indexerLockPath(projectRoot))).toBe(true);
  });

  it('returns false when a live indexer holds the lock', () => {
    // Fake another live indexer by writing a lock with the test runner's pid
    // (which is alive). acquireIndexerLock should refuse.
    writeFileSync(indexerLockPath(projectRoot), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));
    // Now pretend we are a different process by faking the lock's pid as a
    // different live one — but since process.pid IS live and the helper uses
    // process.kill(pid, 0) to probe, any live pid works. The behavior under
    // test: "lock held by a live pid blocks fresh acquire".
    const ok = acquireIndexerLock(projectRoot);
    expect(ok).toBe(false);
  });

  it('overwrites a stale lock (dead pid)', () => {
    // PID 999999 is unlikely to be a real running process on either platform.
    const deadPid = 999999;
    writeFileSync(indexerLockPath(projectRoot), JSON.stringify({
      pid: deadPid,
      startedAt: new Date().toISOString(),
    }));
    expect(isIndexerLockHeld(projectRoot)).toBe(false);

    const ok = acquireIndexerLock(projectRoot);
    expect(ok).toBe(true);
    const lock = JSON.parse(readFileSync(indexerLockPath(projectRoot), 'utf-8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('overwrites a stale lock (old mtime, even with live pid)', () => {
    writeFileSync(indexerLockPath(projectRoot), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));
    // Backdate the mtime to 20 minutes ago — past the 10-min stale threshold.
    const twentyMinAgo = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(indexerLockPath(projectRoot), twentyMinAgo, twentyMinAgo);

    expect(isIndexerLockHeld(projectRoot)).toBe(false);
    const ok = acquireIndexerLock(projectRoot);
    expect(ok).toBe(true);
  });

  it('overwrites a malformed lock file', () => {
    writeFileSync(indexerLockPath(projectRoot), 'not-json-at-all');
    expect(isIndexerLockHeld(projectRoot)).toBe(false);
    const ok = acquireIndexerLock(projectRoot);
    expect(ok).toBe(true);
  });
});

describe('releaseIndexerLock', () => {
  it('removes the lockfile when we own it', () => {
    acquireIndexerLock(projectRoot);
    expect(existsSync(indexerLockPath(projectRoot))).toBe(true);

    releaseIndexerLock(projectRoot);
    expect(existsSync(indexerLockPath(projectRoot))).toBe(false);
  });

  it('is a no-op when the lockfile is missing', () => {
    expect(() => releaseIndexerLock(projectRoot)).not.toThrow();
    expect(existsSync(indexerLockPath(projectRoot))).toBe(false);
  });

  it('does NOT remove a lockfile owned by a different live pid', () => {
    // Write a lock that claims to be held by process.pid but pretend we are
    // a different process by leaving it as a foreign pid. We can't truly run
    // as another pid in-test, but we CAN write the foreign pid value and
    // verify the helper checks pid before unlinking.
    //
    // Use 1 (init on Linux, System on Windows) — guaranteed alive on POSIX,
    // and on Windows process.kill(1, 0) returns EPERM (treated as alive).
    writeFileSync(indexerLockPath(projectRoot), JSON.stringify({
      pid: 1,
      startedAt: new Date().toISOString(),
    }));
    releaseIndexerLock(projectRoot);
    // Should still be there — owned by pid 1, not us.
    expect(existsSync(indexerLockPath(projectRoot))).toBe(true);
  });

  it('is idempotent — safe to call multiple times', () => {
    acquireIndexerLock(projectRoot);
    releaseIndexerLock(projectRoot);
    releaseIndexerLock(projectRoot);
    releaseIndexerLock(projectRoot);
    expect(existsSync(indexerLockPath(projectRoot))).toBe(false);
  });
});

describe('isIndexerLockHeld', () => {
  it('returns false when the lockfile does not exist', () => {
    expect(isIndexerLockHeld(projectRoot)).toBe(false);
  });

  it('returns true when a live indexer holds the lock', () => {
    acquireIndexerLock(projectRoot);
    expect(isIndexerLockHeld(projectRoot)).toBe(true);
  });

  it('returns false after release', () => {
    acquireIndexerLock(projectRoot);
    releaseIndexerLock(projectRoot);
    expect(isIndexerLockHeld(projectRoot)).toBe(false);
  });

  it('returns false for a dead-pid lock', () => {
    writeFileSync(indexerLockPath(projectRoot), JSON.stringify({
      pid: 999999,
      startedAt: new Date().toISOString(),
    }));
    expect(isIndexerLockHeld(projectRoot)).toBe(false);
  });

  it('returns false for a stale (>10min mtime) lock even with a live pid', () => {
    writeFileSync(indexerLockPath(projectRoot), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));
    const twentyMinAgo = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(indexerLockPath(projectRoot), twentyMinAgo, twentyMinAgo);
    expect(isIndexerLockHeld(projectRoot)).toBe(false);
  });

  it('returns false for a malformed lockfile', () => {
    writeFileSync(indexerLockPath(projectRoot), '{not valid json');
    expect(isIndexerLockHeld(projectRoot)).toBe(false);
  });
});
