/**
 * Atomic filesystem writes for files that must not be left corrupted if the
 * process is interrupted mid-write (SIGINT, power loss, ENOSPC) or if multiple
 * processes write to the same target concurrently.
 *
 * Pattern: write to a process-unique temp path `<target>.tmp.<pid>.<rand>`,
 * **fsync the temp file**, then rename onto `target`.
 *   - `writeFileSync` does NOT fsync — the OS keeps data in the write cache.
 *     On Windows that cache isn't always coherent with what other processes
 *     see when they open the freshly-renamed target. Issue #1015 surfaced
 *     this as a flaky `memory-retrieve` race in consumer-smoke: process A
 *     stores via the daemon → daemon flushes via this helper → daemon
 *     returns → process B opens the DB and sees stale content.
 *   - The fix: fsync the temp fd before rename. After fsync, the data is
 *     durably on disk; the rename then makes that durable data visible
 *     atomically. Subsequent readers see the new bytes regardless of cache
 *     state.
 *   - `fs.renameSync` is atomic on POSIX. On Windows, Node maps it to
 *     `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`, which replaces the
 *     destination near-atomically — concurrent readers always observe either
 *     the old file or the new, never a truncated one.
 *   - The unique temp path means concurrent writers can't clobber each other's
 *     in-flight bytes (#635). Last-writer-wins semantics: each rename is fully
 *     atomic, so the destination always reflects exactly one writer's data.
 *     Updates from earlier writers may be lost — that's a separate concern
 *     requiring read-modify-write under a file lock.
 *
 * On any failure, the temp file is best-effort removed and the original
 * `target` stays intact. The underlying error is always re-thrown.
 *
 * Windows-only post-rename verify (#1015): on NTFS with antivirus / Defender
 * scanning the freshly-renamed file, a sub-process opening the same path
 * within ~1s can briefly see the file as locked. After a successful rename
 * we poll-open the target until it's readable (or a 250 ms deadline passes)
 * so the next reader doesn't race the AV lock window. The rename itself
 * already succeeded and the data is fsynced, so the verify is best-effort:
 * a timeout returns silently rather than throwing.
 *
 * `fs` is injectable so the interrupt-mid-write paths can be exercised in
 * unit tests without depending on ESM-unfriendly module spies.
 *
 * @module moflo/cli/shared/utils/atomic-file-write
 */

import * as realFs from 'node:fs';

export interface AtomicWriteFs {
  writeFileSync: typeof realFs.writeFileSync;
  renameSync: typeof realFs.renameSync;
  unlinkSync: typeof realFs.unlinkSync;
  // Used by both the durable-write path (fsync before rename) and the Windows
  // post-rename verify. Optional so existing tests with minimal-shape mocks
  // continue to work — production callers always go through realFs defaults.
  openSync?: typeof realFs.openSync;
  closeSync?: typeof realFs.closeSync;
  fsyncSync?: typeof realFs.fsyncSync;
}

const IS_WIN32 = process.platform === 'win32';
const VERIFY_DEADLINE_MS = 250;
const VERIFY_STEP_MS = 10;

export function atomicWriteFileSync(
  targetPath: string,
  data: Buffer | Uint8Array | string,
  fs: AtomicWriteFs = realFs,
): void {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, data);
    fsyncFile(tmpPath, fs);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup — temp may not exist if writeFileSync failed early */
    }
    throw err;
  }
  if (IS_WIN32) verifyReadableAfterRename(targetPath, fs);
}

/**
 * Open the freshly-written temp file, fsync, close. Ensures the data is
 * durably on disk before rename makes it visible (#1015). Best-effort: an
 * fsync error is swallowed because a real filesystem failure will surface
 * on the rename anyway, and we don't want to mask the more useful error.
 */
function fsyncFile(tmpPath: string, fs: AtomicWriteFs): void {
  const openSync = fs.openSync ?? realFs.openSync;
  const closeSync = fs.closeSync ?? realFs.closeSync;
  const fsyncSync = fs.fsyncSync ?? realFs.fsyncSync;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'r+');
    fsyncSync(fd);
  } catch {
    /* fsync best-effort — see fn doc */
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* close best-effort */ }
    }
  }
}

/**
 * Poll-open the target until a reader can succeed, or the deadline passes.
 * Closes the AV-scan settle window on NTFS (#1015). No-op everywhere else.
 *
 * Yields the thread between probes via `Atomics.wait` so we don't pin a CPU
 * during the very contention we're waiting out (`feedback_async_by_default`).
 */
function verifyReadableAfterRename(targetPath: string, fs: AtomicWriteFs): void {
  const openSync = fs.openSync ?? realFs.openSync;
  const closeSync = fs.closeSync ?? realFs.closeSync;
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  while (true) {
    try {
      closeSync(openSync(targetPath, 'r'));
      return;
    } catch {
      if (Date.now() >= deadline) return;
      sleepSyncMs(VERIFY_STEP_MS);
    }
  }
}

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}
