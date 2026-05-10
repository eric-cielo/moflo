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
