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
 * Algorithm (#1057, #1174) — three-pass walk so memory markers always win
 * across the ENTIRE ancestor chain (not just at the first level they appear):
 *   1. `process.env.CLAUDE_PROJECT_DIR`, if set (Claude Code / explicit override).
 *   2. **Pass A — memory markers (topmost wins).** Walk from
 *      `opts.cwd ?? process.cwd()` up to the filesystem root, collecting EVERY
 *      level that has `.moflo/moflo.db` OR `.swarm/memory.db`. Return the
 *      topmost (highest ancestor) match. This is the #1174 fix — pre-#1174 the
 *      walk stopped at the nearest hit, fragmenting monorepos into daemon
 *      islands.
 *   3. **Pass B — project marker pair (nearest wins).** Only reached when no
 *      moflo state exists anywhere up the tree. Walk again looking for
 *      `<dir>/CLAUDE.md` AND `<dir>/package.json` at the same level; return
 *      the nearest match.
 *   4. **Pass C — bare project markers (nearest wins).** Walk again looking
 *      for `<dir>/package.json` OR `<dir>/.git`; return the nearest match.
 *   5. Fall back to `opts.cwd ?? process.cwd()`.
 *
 * `node_modules` segments are always skipped (npx run can land cwd inside one).
 *
 * Why topmost (Pass A)? When a monorepo has nested `.moflo/moflo.db` directories
 * — typically because `flo init` was run from a subworkspace before #1174 — the
 * MCP server, daemon, CLI, and gate hooks ALL must agree on a single anchor.
 * Topmost wins means the root daemon is canonical; sub-daemons become
 * detectable residue that `flo doctor --fix` archives. Nearest-wins fragments
 * state silently because every cwd resolves to a different anchor.
 *
 * Why nearest (Pass B/C)? Pass B/C only fires when there's no moflo state at
 * all. In a fresh checkout the user expects `flo init` to anchor at the
 * project they're in, not at some ancestor `.git`/`package.json` directory.
 *
 * Story #229 history: this function was first extracted from workflow-tools.ts;
 * #1057 brought it into alignment with bridge-core.getProjectRoot(); #1174
 * changed Pass A from nearest-wins to topmost-wins to fix monorepo daemon
 * fragmentation.
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

/**
 * Walk strictly upward from `dir` (exclusive) and return the nearest ancestor
 * that has `.moflo/moflo.db`, or `null` if none exists below the filesystem
 * root.
 *
 * Used by `flo init` and the session-start launcher to detect nested-.moflo
 * situations (#1174). Post-resolver-fix `findProjectRoot` returns the topmost
 * memory marker, so encountering an ancestor here means either:
 *   1. `CLAUDE_PROJECT_DIR` explicitly overrode to a sub-directory
 *      (legitimate user action — log a warning but don't refuse), or
 *   2. The caller is operating on a directory that's about to become a new
 *      nested .moflo/ island (e.g. `flo init` in a sub-workspace).
 *
 * Algorithmic twin of `bin/lib/moflo-paths.mjs:findAncestorMofloRoot()`.
 */
export function findAncestorMofloRoot(dir: string): string | null {
  const start = resolve(dir);
  const fsRoot = parse(start).root;
  let cursor = dirname(start);
  while (cursor !== fsRoot) {
    if (existsSync(join(cursor, '.moflo', 'moflo.db'))) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

export function findProjectRoot(opts?: FindProjectRootOptions): string {
  const honorEnv = opts?.honorEnv !== false;
  if (honorEnv && process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  const startDir = opts?.cwd ?? process.cwd();
  const start = resolve(startDir);
  const fsRoot = parse(start).root;

  // Pass A — memory markers, topmost wins (#1174).
  // Collect every ancestor with `.moflo/moflo.db` or `.swarm/memory.db`, then
  // return the highest one. Guarantees the root daemon is canonical in a
  // monorepo with nested .moflo/ residue.
  let topmostMemoryMarker: string | null = null;
  let dir = start;
  while (dir !== fsRoot) {
    if (basename(dir) === 'node_modules') {
      dir = dirname(dir);
      continue;
    }
    if (existsSync(join(dir, '.moflo', 'moflo.db')) || existsSync(join(dir, '.swarm', 'memory.db'))) {
      topmostMemoryMarker = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (topmostMemoryMarker) return topmostMemoryMarker;

  // Pass B — project marker pair, nearest wins. Only reached when no moflo
  // state exists anywhere up the tree.
  dir = start;
  while (dir !== fsRoot) {
    if (basename(dir) === 'node_modules') {
      dir = dirname(dir);
      continue;
    }
    if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Pass C — bare package.json or .git, nearest wins.
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
