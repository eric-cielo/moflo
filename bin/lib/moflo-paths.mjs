/**
 * Pure-JS counterpart to src/cli/services/moflo-paths.ts and the
 * findProjectRoot helper in src/cli/services/project-root.ts.
 *
 * Lives in bin/lib because session-start-launcher.mjs and other bin/ scripts
 * run before any TS compilation has happened — they can't import the .ts
 * source. The TS versions are the canonical programmatic API; this file
 * exposes the same path constants + helpers and MUST stay algorithmically
 * identical (see tests/system/project-root-twin.test.ts).
 *
 * Per #851, the legacy `.claude-flow/` rename + `.swarm/memory.db` byte-copy
 * helpers no longer ship: the version-bump-gated cherry-pick lives entirely
 * in the launcher and the TS service `cli/services/cherry-pick-learnings.ts`.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';

export const MOFLO_DIR = '.moflo';
export const MEMORY_DB_FILE = 'moflo.db';
export const HNSW_INDEX_FILE = 'hnsw.index';

export const LEGACY_CLAUDE_FLOW_DIR = '.claude-flow';
export const LEGACY_SWARM_DIR = '.swarm';
export const LEGACY_MEMORY_DB_FILE = 'memory.db';
export const LEGACY_MEMORY_DB_BAK_SUFFIX = '.bak';

export function mofloDir(projectRoot) {
  return join(projectRoot, MOFLO_DIR);
}

export function legacyClaudeFlowDir(projectRoot) {
  return join(projectRoot, LEGACY_CLAUDE_FLOW_DIR);
}

export function memoryDbPath(projectRoot) {
  return join(projectRoot, MOFLO_DIR, MEMORY_DB_FILE);
}

export function hnswIndexPath(projectRoot) {
  return join(projectRoot, MOFLO_DIR, HNSW_INDEX_FILE);
}

export function legacyMemoryDbPath(projectRoot) {
  return join(projectRoot, LEGACY_SWARM_DIR, LEGACY_MEMORY_DB_FILE);
}

export function legacyHnswIndexPath(projectRoot) {
  return join(projectRoot, LEGACY_SWARM_DIR, HNSW_INDEX_FILE);
}

export function legacyMemoryDbBakPath(projectRoot) {
  return join(projectRoot, LEGACY_SWARM_DIR, `${LEGACY_MEMORY_DB_FILE}${LEGACY_MEMORY_DB_BAK_SUFFIX}`);
}

export function memoryDbCandidatePaths(projectRoot) {
  return [
    memoryDbPath(projectRoot),
    legacyMemoryDbPath(projectRoot),
    join(projectRoot, 'data', LEGACY_MEMORY_DB_FILE),
    join(projectRoot, '.claude', LEGACY_MEMORY_DB_FILE),
  ];
}

/**
 * Walk strictly upward from `dir` (exclusive) and return the nearest ancestor
 * that has `.moflo/moflo.db`, or `null` if none exists below the filesystem
 * root.
 *
 * Used by the launcher and `flo init` to detect nested-.moflo/ situations
 * (#1174). Post-resolver-fix `findProjectRoot` already returns the topmost
 * memory marker, so encountering an ancestor here means either:
 *   1. `CLAUDE_PROJECT_DIR` explicitly overrode to a sub-directory (legitimate
 *      user action — log a warning but don't refuse), or
 *   2. The launcher is running before any `.moflo/moflo.db` exists at the
 *      current root (e.g. fresh init in a sub-workspace).
 *
 * In either case the caller wants to surface a clear diagnostic so the user
 * can run `flo doctor --fix` to consolidate.
 *
 * @param {string} dir absolute path to walk up from
 * @returns {string | null} ancestor directory containing `.moflo/moflo.db`
 */
export function findAncestorMofloRoot(dir) {
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
 * Resolve the project root the same way the TS bridge does. Every bin/
 * script that touches `.moflo/moflo.db` (or any sibling state under
 * `.moflo/`) MUST go through this so its writes land on the SAME file the
 * bridge reads from.
 *
 * Algorithmic twin of `src/cli/services/project-root.ts:findProjectRoot()`
 * and `src/cli/memory/bridge-core.ts:getProjectRoot()`. See those files for
 * the canonical algorithm comment.
 *
 * @param {{ cwd?: string; honorEnv?: boolean }} [opts]
 * @returns {string} absolute project root
 */
export function findProjectRoot(opts) {
  const honorEnv = opts?.honorEnv !== false;
  if (honorEnv && process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  const startDir = opts?.cwd ?? process.cwd();
  const start = resolve(startDir);
  const fsRoot = parse(start).root;

  // Pass A — memory markers, topmost wins (#1174). Walks the FULL ancestor
  // chain, returns the highest ancestor with .moflo/moflo.db or .swarm/memory.db.
  // Guarantees the root daemon is canonical in a monorepo with nested residue.
  let topmostMemoryMarker = null;
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

  // Pass B — CLAUDE.md/package.json pair, nearest wins.
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
