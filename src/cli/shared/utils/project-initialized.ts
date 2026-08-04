/**
 * Shared "is this project moflo-initialized?" predicate (#1363).
 *
 * `flo status` and `flo start` each carried their own copy that tested for
 * `.moflo/config.yaml` and nothing else. That file is written by
 * `writeRuntimeConfig()` in `src/cli/init/executor.ts` only under
 * `if (options.components.runtime)`, so any consumer who inits with a component
 * subset never receives it — and both commands then hard-failed with
 * "MoFlo is not initialized in this directory" on an install with a healthy
 * `.moflo/`, a running daemon, and a working MCP server.
 *
 * Nothing load-bears on `.moflo/config.yaml`: `src/cli/config/cli-config-store.ts`
 * treats it as one candidate among several. So the gate is widened to any
 * genuine init marker, and lives in one place rather than two.
 *
 * Cross-platform: `path.join` throughout, no separator or case assumptions.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Config files that, alongside a `.moflo/` directory, mark a project as
 * initialized. Paths are relative to the project root and joined per-platform.
 */
const INIT_MARKERS: readonly string[][] = [
  ['moflo.yaml'],
  ['moflo.config.json'],
  ['.moflo', 'config.yaml'],
  ['.moflo', 'config.json'],
];

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    // ENOENT, ENOTDIR, EACCES — treat every failure as "not a directory"
    // rather than letting a permissions edge case crash the command.
    return false;
  }
}

/**
 * True when `cwd` looks like a moflo-initialized project.
 *
 * Requires the `.moflo/` state directory AND at least one recognized config
 * marker — the directory alone can be left behind by a partial teardown, and a
 * stray `moflo.yaml` alone means init never ran.
 */
export function isProjectInitialized(cwd: string): boolean {
  if (!isDirectory(path.join(cwd, '.moflo'))) return false;
  return INIT_MARKERS.some((segments) => fs.existsSync(path.join(cwd, ...segments)));
}
