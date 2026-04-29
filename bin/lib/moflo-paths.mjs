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
  writeFileSync,
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
 * Returns `{ migrated, reason?, movedCount?, collisions? }`. The launcher
 * uses `movedCount` for the "migrated N files" message and `collisions` to
 * warn about subdirs (e.g. models/) that exist in both locations.
 */
export function migrateClaudeFlowToMoflo(projectRoot) {
  const legacy = legacyClaudeFlowDir(projectRoot);
  const target = mofloDir(projectRoot);

  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };

  if (!existsSync(target)) {
    let movedCount = 0;
    try { movedCount = readdirSync(legacy).length; } catch { /* count is cosmetic */ }
    renameSync(legacy, target);
    rewriteEmbeddingsModelPath(projectRoot);
    return { migrated: true, movedCount };
  }

  let entries;
  try {
    entries = readdirSync(legacy);
  } catch {
    return { migrated: false, reason: 'legacy-unreadable' };
  }

  let moved = 0;
  let modelsMoved = false;
  const collisions = [];
  for (const name of entries) {
    const dst = join(target, name);
    if (existsSync(dst)) {
      collisions.push(name);
      continue;
    }
    try {
      renameSync(join(legacy, name), dst);
      moved++;
      if (name === 'models') modelsMoved = true;
    } catch {
      // Best-effort — single failed move shouldn't abort the rest.
    }
  }

  try {
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    // Non-fatal — leftover legacy dir means migration runs next time.
  }

  if (modelsMoved) rewriteEmbeddingsModelPath(projectRoot);

  if (moved === 0) {
    return { migrated: false, reason: 'merged-nothing', movedCount: 0, collisions };
  }
  return { migrated: true, movedCount: moved, collisions };
}

/**
 * Rewrite `.moflo/embeddings.json:modelPath` if it still references the
 * legacy `.claude-flow/` location (#735). Best-effort: file-not-present,
 * malformed JSON, missing field, or already-correct path → silent no-op.
 * Mirrors the TS twin in src/cli/services/moflo-paths.ts. Uses tmp+rename
 * so SIGINT mid-flush can't leave embeddings.json truncated.
 */
export function rewriteEmbeddingsModelPath(projectRoot) {
  const cfgPath = join(projectRoot, MOFLO_DIR, 'embeddings.json');

  let raw;
  try { raw = readFileSync(cfgPath, 'utf8'); } catch { return false; }

  let cfg;
  try { cfg = JSON.parse(raw); } catch { return false; }

  if (typeof cfg.modelPath !== 'string') return false;
  if (!cfg.modelPath.includes(LEGACY_CLAUDE_FLOW_DIR)) return false;

  cfg.modelPath = cfg.modelPath.split(LEGACY_CLAUDE_FLOW_DIR).join(MOFLO_DIR);

  const tmpPath = `${cfgPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
    renameSync(tmpPath, cfgPath);
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return false;
  }
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
