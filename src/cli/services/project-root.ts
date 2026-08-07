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

import { existsSync, realpathSync } from 'node:fs';
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
/**
 * Does `dir` carry moflo state that makes it a project root?
 *
 * The single source of truth for Pass A's marker set, exported so callers that
 * must agree with the resolver cannot drift from it. #1431 is exactly that
 * drift: `doctor-fixes.ts` guarded its daemon reaps by looking for
 * `.moflo/moflo.db` alone, went blind to a nested checkout carrying only the
 * legacy `.swarm/memory.db`, and allowed the parent project's daemons to be
 * killed. Any new marker belongs here and nowhere else.
 *
 * (`bin/lib/moflo-paths.mjs` holds a plain-JS twin for the launcher, which
 * cannot import TypeScript — keep the two in step.)
 */
export function hasMofloStateMarker(dir: string): boolean {
  return existsSync(join(dir, '.moflo', 'moflo.db')) || existsSync(join(dir, '.swarm', 'memory.db'));
}

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

/**
 * Memo for {@link resolveStateRoot}, keyed on the two inputs that can change
 * within a process: the starting directory and `CLAUDE_PROJECT_DIR`.
 *
 * Only MARKER-PROVEN results are cached — i.e. resolutions that landed on a
 * directory actually holding `.moflo/moflo.db`. That distinction is what makes
 * the cache safe: an existing `moflo.db` does not move during a process
 * lifetime, whereas a fall-through result (Pass B/C, no moflo state anywhere)
 * is exactly the case `flo init` is about to invalidate by creating one. So
 * the un-cached path stays correct and the cached path stays stable.
 *
 * Motivation: a single `flo doctor` run resolves independently from ~6 check
 * modules, each re-walking the ancestor chain.
 */
const stateRootCache = new Map<string, string>();

/** Clear the {@link resolveStateRoot} memo. Test seam only. */
export function _resetStateRootCacheForTest(): void {
  stateRootCache.clear();
}

/**
 * Resolve the anchor that any code READING OR WRITING `.moflo/` state must use
 * (#1315). Use this instead of `process.cwd()` anywhere a `.moflo/` path is
 * built — the daemon, the healer, and any command that persists metrics,
 * benchmarks, or reports.
 *
 * `findProjectRoot()` short-circuits on `CLAUDE_PROJECT_DIR` before Pass A.
 * That is correct for most callers, but wrong for state anchoring: Claude Code
 * sets the variable to the SESSION's directory, hooks inherit it, and a spawned
 * daemon inherits it again via `daemonEnv` (`commands/daemon.ts`). In a
 * monorepo session rooted at a sub-workspace the whole chain therefore agreed
 * the project root was the sub-workspace, and `daemon start` minted a fresh
 * `.moflo/` there — re-seeding the daemon islands #1174 was closed for.
 *
 * The rule here: an existing `CLAUDE_PROJECT_DIR` wins outright — it is what
 * Claude Code says the project is, and the marker walk is never allowed to
 * climb above it. Otherwise walk up from cwd and take the TOPMOST
 * `.moflo/moflo.db`, which is the canonical root for a monorepo. That walk is
 * the actual #1315 fix: the state sites previously used `process.cwd()` raw,
 * so every sub-directory invocation minted an island where it stood.
 *
 * Why the env is not merely a starting point: the walk has no upper bound, so
 * climbing past an explicit anchor lets any stray ancestor marker capture every
 * project beneath it. See the note in `resolveStateRootUncached`.
 *
 * Deliberately a separate export rather than a change inside `findProjectRoot`
 * itself: that resolver is shared with the MCP server, the memory bridge, and
 * the gate hooks, whose env-override semantics are load-bearing elsewhere.
 * Callers that merely need "which project am I in" should keep using
 * `findProjectRoot`; callers that are about to CREATE something use this.
 */
export function resolveStateRoot(opts?: { cwd?: string }): string {
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  const cacheKey = `${opts?.cwd ?? process.cwd()}\0${envDir ?? ''}`;
  const cached = stateRootCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolved = resolveStateRootUncached(opts, envDir);
  // Cache only a marker-proven anchor — see the note on `stateRootCache`.
  if (existsSync(join(resolved, '.moflo', 'moflo.db'))) {
    stateRootCache.set(cacheKey, resolved);
  }
  return resolved;
}

function resolveStateRootUncached(opts: { cwd?: string } | undefined, envDir: string | undefined): string {
  // An explicitly-set `CLAUDE_PROJECT_DIR` is AUTHORITATIVE and is never
  // climbed above. Claude Code sets it to the project the user opened, and the
  // marker walk has no upper bound — it runs to the filesystem root and takes
  // the TOPMOST `.moflo/moflo.db`. Letting it climb past an explicit anchor
  // means any stray ancestor marker captures every project beneath it: one
  // accidental `flo init` in `$HOME` silently re-roots everything, and a
  // scratch project created inside another checkout resolves to that checkout
  // and mutates it. (Verified, not hypothetical: with the climb enabled the
  // session-start launcher operated on this repo instead of its fixture.)
  //
  // A typo'd or stale value naming a directory that does not exist is ignored
  // — callers mkdir what we return, so honoring it would materialize `.moflo/`
  // at the typo path.
  const envAbs = envDir ? resolve(envDir) : undefined;
  if (envAbs && existsSync(envAbs)) {
    return canonicalize(envAbs);
  }

  // No usable env anchor: walk up from cwd. This is the #1315 fix proper —
  // the state-anchoring sites used to take `process.cwd()` raw, so any
  // sub-directory invocation minted an island there. Pass A's topmost-wins
  // walk lands on the canonical root instead.
  const resolved = findProjectRoot({ honorEnv: false, cwd: opts?.cwd });

  return canonicalize(resolved);
}

/**
 * Absolutize + realpath a resolved root.
 *
 * The env value is caller-supplied and may be relative or carry a trailing
 * separator, and on macOS `/var/folders/...` must collapse to
 * `/private/var/folders/...` or this root won't compare equal to the realpath'd
 * one `daemon-port.ts:normalizeProjectRoot` derives for same-project matching
 * (CLAUDE.md Rule #1 §2). Falls back to the un-canonicalized path when it
 * doesn't exist, which is the right degradation — never throw from a resolver.
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
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
    if (hasMofloStateMarker(dir)) {
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
