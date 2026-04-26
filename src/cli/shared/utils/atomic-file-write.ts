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
 * `fs` is injectable so the interrupt-mid-write paths can be exercised in
 * unit tests without depending on ESM-unfriendly module spies.
 *
 * @module @moflo/shared/utils/atomic-file-write
 */

import * as realFs from 'node:fs';

export interface AtomicWriteFs {
  writeFileSync: typeof realFs.writeFileSync;
  renameSync: typeof realFs.renameSync;
  unlinkSync: typeof realFs.unlinkSync;
}

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
}
