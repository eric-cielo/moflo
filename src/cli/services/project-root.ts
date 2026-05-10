/**
 * Project Root Discovery — canonical resolver.
 *
 * Walks up from cwd to find the project's anchor directory using the same
 * algorithm as `src/cli/memory/bridge-core.ts:getProjectRoot()` and the pure-JS
 * twin at `bin/lib/moflo-paths.mjs:findProjectRoot()`. Every writer that
 * touches `.moflo/moflo.db` (bin scripts, MCP tools, healers, daemon) MUST
 * resolve through this single algorithm or its JS twin — otherwise different
 * writers land on different DBs and the bridge reads stale data.
 *
 * Algorithm (#1057) — two-pass walk so memory markers always win:
 *   1. `process.env.CLAUDE_PROJECT_DIR`, if set (Claude Code / explicit override).
 *   2. **High-priority pass.** Walk from `opts.cwd ?? process.cwd()` up to the
 *      filesystem root, looking at each level for (in order):
 *        a. `<dir>/.moflo/moflo.db`            — canonical memory DB marker
 *        b. `<dir>/.swarm/memory.db`           — legacy memory DB marker (pre-#727)
 *        c. `<dir>/CLAUDE.md` AND `<dir>/package.json` — project marker pair
 *      If anything matches, return that dir. `node_modules` segments are
 *      skipped (npx run can land cwd inside one).
 *   3. **Low-priority pass.** Walk again from cwd up to root looking for:
 *        d. `<dir>/package.json`               — generic project marker
 *        e. `<dir>/.git`                       — git repo marker
 *      Return the first match.
 *   4. Fall back to `opts.cwd ?? process.cwd()`.
 *
 * Why two passes? An upstream `.moflo/moflo.db` MUST win over a nested
 * `package.json` (monorepo sub-package case) — otherwise the writer lands on
 * a different DB than the bridge. Doing it in a single pass with bare
 * `package.json` as a per-level marker would short-circuit at the nearest
 * package.json before ever seeing the upstream memory marker.
 *
 * Story #229 history: this function was first extracted from workflow-tools.ts;
 * #1057 brought it into alignment with bridge-core.getProjectRoot().
 */

import { existsSync } from 'node:fs';
import { resolve, dirname, parse, join, basename } from 'node:path';

export interface FindProjectRootOptions {
  /** Override the starting directory. Default: `process.cwd()`. */
  cwd?: string;
  /**
   * If true, honor `CLAUDE_PROJECT_DIR` when set. Default: true.
   * Pass `false` only for diagnostics (e.g. doctor wants to see the "natural"
   * walk-up result for comparison against the override).
   */
  honorEnv?: boolean;
}

export function findProjectRoot(opts?: FindProjectRootOptions): string {
  const honorEnv = opts?.honorEnv !== false;
  if (honorEnv && process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  const startDir = opts?.cwd ?? process.cwd();
  const start = resolve(startDir);
  const fsRoot = parse(start).root;

  // High-priority pass: memory markers + CLAUDE.md/package.json pair.
  let dir = start;
  while (dir !== fsRoot) {
    if (basename(dir) === 'node_modules') {
      dir = dirname(dir);
      continue;
    }
    if (existsSync(join(dir, '.moflo', 'moflo.db'))) return dir;
    if (existsSync(join(dir, '.swarm', 'memory.db'))) return dir;
    if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Low-priority pass: bare package.json or .git.
  dir = start;
  while (dir !== fsRoot) {
    if (basename(dir) === 'node_modules') {
      dir = dirname(dir);
      continue;
    }
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return startDir;
}
