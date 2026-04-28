/**
 * Pure-JS counterpart to src/cli/services/moflo-paths.ts (#699, #727).
 *
 * Lives in bin/lib because session-start-launcher.mjs and other bin/ scripts
 * run before any TS compilation has happened — they can't import the .ts
 * source. The TS version is the canonical programmatic API; this version
 * mirrors the same algorithm so migration also runs from the consumer
 * launcher path. Algorithm parity is enforced by the parity case in
 * src/cli/__tests__/services/moflo-paths-migration.test.ts.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
 * One-time migration of `.claude-flow/` → `.moflo/`. Idempotent — safe to call
 * on every session start. See moflo-paths.ts for the full contract.
 *
 * Returns `{ migrated, reason? }`.
 */
export function migrateClaudeFlowToMoflo(projectRoot) {
  const legacy = legacyClaudeFlowDir(projectRoot);
  const target = mofloDir(projectRoot);

  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };

  if (!existsSync(target)) {
    renameSync(legacy, target);
    return { migrated: true };
  }

  let entries;
  try {
    entries = readdirSync(legacy);
  } catch {
    return { migrated: false, reason: 'legacy-unreadable' };
  }

  let moved = 0;
  for (const name of entries) {
    const dst = join(target, name);
    if (existsSync(dst)) continue;
    try {
      renameSync(join(legacy, name), dst);
      moved++;
    } catch {
      // Best-effort — single failed move shouldn't abort the rest.
    }
  }

  try {
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    // Non-fatal — leftover legacy dir means migration runs next time.
  }

  return moved > 0 ? { migrated: true } : { migrated: false, reason: 'merged-nothing' };
}

const SQLITE_MAGIC_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function looksLikeSqliteFile(filePath) {
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(SQLITE_MAGIC_HEADER.length);
    const read = readSync(fd, buf, 0, buf.length, 0);
    if (read < SQLITE_MAGIC_HEADER.length) return false;
    return buf.equals(SQLITE_MAGIC_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* non-fatal */ }
  }
}

function verifyByteEqual(srcPath, dstPath) {
  try {
    const srcStat = statSync(srcPath);
    const dstStat = statSync(dstPath);
    if (srcStat.size !== dstStat.size) return false;
    const srcBuf = readFileSync(srcPath);
    const dstBuf = readFileSync(dstPath);
    return srcBuf.equals(dstBuf);
  } catch {
    return false;
  }
}

function tryUnlink(filePath) {
  try { unlinkSync(filePath); } catch { /* non-fatal */ }
}

function migrateHnswIndex(projectRoot) {
  const src = legacyHnswIndexPath(projectRoot);
  const dst = hnswIndexPath(projectRoot);

  if (!existsSync(src)) return false;
  if (existsSync(dst)) return false;

  try {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  } catch {
    tryUnlink(dst);
    return false;
  }

  if (!verifyByteEqual(src, dst)) {
    tryUnlink(dst);
    return false;
  }

  tryUnlink(src);
  return true;
}

/**
 * One-time relocation of memory DB from `.swarm/memory.db` → `.moflo/moflo.db`
 * (story #727). Idempotent. See moflo-paths.ts for the full contract and the
 * SQLite-header / byte-equal verification rationale.
 *
 * MUST run before any long-lived sql.js consumer (MCP server, daemon) opens
 * the DB — sql.js dumps the whole snapshot on every flush and would clobber
 * the relocated file. Launcher section 0b is the safe boundary.
 */
export function migrateMemoryDbToMoflo(projectRoot) {
  const target = memoryDbPath(projectRoot);
  if (existsSync(target)) return { migrated: false, reason: 'target-exists' };

  const source = legacyMemoryDbPath(projectRoot);
  if (!existsSync(source)) return { migrated: false, reason: 'no-legacy' };

  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch {
    return { migrated: false, reason: 'copy-failed' };
  }

  try {
    copyFileSync(source, target);
  } catch {
    tryUnlink(target);
    return { migrated: false, reason: 'copy-failed' };
  }

  if (!verifyByteEqual(source, target) || !looksLikeSqliteFile(target)) {
    tryUnlink(target);
    return { migrated: false, reason: 'verify-failed' };
  }

  const hnswMoved = migrateHnswIndex(projectRoot);

  try {
    renameSync(source, legacyMemoryDbBakPath(projectRoot));
  } catch {
    return { migrated: true, reason: 'rename-failed', hnswMoved };
  }

  return { migrated: true, hnswMoved };
}
