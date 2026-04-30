import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the absolute path to moflo's own installed package root — the
 * directory that contains `package.json` with `name === 'moflo'` and the
 * shipped `bin/`, `dist/`, etc. trees.
 *
 * Walks up from `import.meta.url` of the calling file until it finds that
 * package.json. Anchored on the source file (not `process.cwd()`), so it
 * works identically when moflo is the active project AND when moflo is
 * installed at `node_modules/moflo/...` inside a consumer project.
 *
 * Issue #781 / #782 — replace ad-hoc `resolve(__dirname, '..', '..', ...)`
 * walks that bake in fragile depth assumptions and break whenever files
 * move (workspace-collapse #586 broke ~half a dozen of these).
 */
let cached: string | undefined;

export function mofloPackageRoot(callerUrl: string): string {
  if (cached) return cached;

  let dir = dirname(fileURLToPath(callerUrl));
  while (true) {
    const pkgJson = join(dir, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string };
        if (parsed.name === 'moflo') {
          cached = dir;
          return dir;
        }
      } catch {
        // Malformed package.json — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `mofloPackageRoot: could not find a parent package.json with name 'moflo' (started from ${callerUrl})`,
      );
    }
    dir = parent;
  }
}

export function mofloPath(callerUrl: string, ...segments: string[]): string {
  return resolve(mofloPackageRoot(callerUrl), ...segments);
}
