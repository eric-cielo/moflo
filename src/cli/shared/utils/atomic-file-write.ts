/**
 * Atomic filesystem writes for files that must not be left corrupted if the
 * process is interrupted mid-write (SIGINT, power loss, ENOSPC) or if multiple
 * processes write to the same target concurrently.
 *
 * Pattern: write to a process-unique temp path `<target>.tmp.<pid>.<rand>`,
 * then rename onto `target`.
 *   - `fs.renameSync` is atomic on POSIX.
 *   - On Windows, Node maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`,
 *     which replaces the destination near-atomically — concurrent readers
 *     always observe either the old file or the new, never a truncated one.
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
 * within ~1s can briefly see stale or unreadable data. After a successful
 * rename we poll-open the target until it's readable (or a 250 ms deadline
 * passes) so the next reader doesn't race the AV settle window. The rename
 * itself already succeeded, so the verify is best-effort: a timeout logs and
 * returns rather than throwing — the data IS on disk, the next reader will
 * just briefly hit the same lock anyway.
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
  // Optional — used only by the Windows post-rename verify path. Real callers
  // never pass these; tests inject them to simulate AV-induced transient
  // EBUSY without depending on a real Windows host.
  openSync?: typeof realFs.openSync;
  closeSync?: typeof realFs.closeSync;
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
