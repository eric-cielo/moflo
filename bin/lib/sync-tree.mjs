/**
 * Pure-JS counterpart to the install-manifest sync logic so bin/ scripts can
 * run pre-compile and the launcher can import it without crossing the
 * compiled-TS boundary. Created to fix #777, where flat `readdirSync` loops
 * silently dropped subdirectories like `bin/migrations/lib/` — and with them
 * the dependencies of files that were shipped in the npm tarball.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Walk srcRoot recursively and copy every file into destRoot, recording each
 * file at `${manifestPrefix}/<rel>` in the supplied manifest array. Source
 * mtime gates the copy so unchanged files don't get rewritten on every
 * session start (which would also bump dest mtime and defeat the gate next
 * time).
 *
 * Best-effort: missing srcRoot is a no-op, per-file errors are swallowed —
 * the launcher must never crash on a sync error.
 *
 * @param {string} srcRoot
 * @param {string} destRoot
 * @param {string} manifestPrefix
 * @param {string[]} manifest
 */
export function syncTree(srcRoot, destRoot, manifestPrefix, manifest) {
  if (!existsSync(srcRoot)) return;
  let entries;
  try {
    entries = readdirSync(srcRoot, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Node ≥20.5 surfaces parentPath; older 20.x ABIs called it path.
    const parent = entry.parentPath || entry.path || srcRoot;
    const absSrc = resolve(parent, entry.name);
    const rel = absSrc.slice(srcRoot.length + 1).split(/[\\/]/).join('/');
    const absDest = resolve(destRoot, rel);
    try {
      mkdirSync(dirname(absDest), { recursive: true });
      let shouldCopy = true;
      try {
        if (statSync(absSrc).mtimeMs <= statSync(absDest).mtimeMs) shouldCopy = false;
      } catch { /* dest missing — copy */ }
      if (shouldCopy) copyFileSync(absSrc, absDest);
      manifest.push(`${manifestPrefix}/${rel}`);
    } catch {
      // non-fatal — skip individual file
    }
  }
}
