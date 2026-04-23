/**
 * Atomic filesystem writes for files that must not be left corrupted if the
 * process is interrupted mid-write (SIGINT, power loss, ENOSPC).
 *
 * Pattern: write to `<target>.tmp`, then rename onto `target`.
 *   - `fs.renameSync` is atomic on POSIX.
 *   - On Windows, Node maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`,
 *     which replaces the destination near-atomically — concurrent readers
 *     always observe either the old file or the new, never a truncated one.
 *
 * On any failure, the temp file is best-effort removed and the original
 * `target` stays intact. The underlying error is always re-thrown.
 *
 * `fs` is injectable so the interrupt-mid-write paths can be exercised in
 * unit tests without depending on ESM-unfriendly module spies.
 *
 * @module @moflo/cli/services/atomic-file-write
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
  const tmpPath = `${targetPath}.tmp`;
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
