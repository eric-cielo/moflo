/**
 * MoFlo runtime state directory constants + legacy migrations (#699, #727).
 *
 * MoFlo owns its state under `.moflo/` at the project root. The upstream Ruflo
 * fork used `.claude-flow/`; consumers upgrading from older moflo builds (which
 * inherited that path) get a one-time auto-migration so they don't lose claim
 * files, daemon state, metrics, etc.
 *
 * Anything that touches a runtime state path under the project root must
 * compose it from `MOFLO_DIR`. Plain string literals like `'.moflo'` are
 * tolerated where a constant import is awkward (shell templates, tests) but
 * production code is checked by `published-package-drift-guard.test.ts`.
 *
 * The pure-JS twin at `bin/lib/moflo-paths.mjs` mirrors the algorithm so
 * `bin/session-start-launcher.mjs` can run the migration before any TS has
 * been compiled. The parity test in moflo-paths-migration.test.ts catches
 * algorithm divergence between the two.
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
/** Canonical memory DB filename (post-#727). Lives at `<root>/.moflo/moflo.db`. */
export const MEMORY_DB_FILE = 'moflo.db';
/** HNSW persisted index sidecar. Lives next to the DB at `<root>/.moflo/hnsw.index`. */
export const HNSW_INDEX_FILE = 'hnsw.index';

/**
 * Legacy runtime directory inherited from upstream Ruflo. Only referenced from
 * migration code paths — production code should use {@link MOFLO_DIR}.
 */
export const LEGACY_CLAUDE_FLOW_DIR = '.claude-flow';
/** Legacy `.swarm/` directory used by Ruflo + pre-#727 moflo for the memory DB. */
export const LEGACY_SWARM_DIR = '.swarm';
/** Legacy memory DB filename — only ever inside `.swarm/`. Pre-#727. */
export const LEGACY_MEMORY_DB_FILE = 'memory.db';
/** Suffix appended to `.swarm/memory.db` once migrated, retained one upgrade cycle. */
export const LEGACY_MEMORY_DB_BAK_SUFFIX = '.bak';

export function mofloDir(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR);
}

export function legacyClaudeFlowDir(projectRoot: string): string {
  return join(projectRoot, LEGACY_CLAUDE_FLOW_DIR);
}

/** Canonical memory DB path: `<root>/.moflo/moflo.db`. */
export function memoryDbPath(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR, MEMORY_DB_FILE);
}

/** Canonical HNSW index sidecar path: `<root>/.moflo/hnsw.index`. */
export function hnswIndexPath(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR, HNSW_INDEX_FILE);
}

/** Legacy memory DB path: `<root>/.swarm/memory.db`. Migration source only. */
export function legacyMemoryDbPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_SWARM_DIR, LEGACY_MEMORY_DB_FILE);
}

/** Legacy HNSW index path: `<root>/.swarm/hnsw.index`. Migration source only. */
export function legacyHnswIndexPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_SWARM_DIR, HNSW_INDEX_FILE);
}

/** Backup sentinel kept for one upgrade cycle: `<root>/.swarm/memory.db.bak`. */
export function legacyMemoryDbBakPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_SWARM_DIR, `${LEGACY_MEMORY_DB_FILE}${LEGACY_MEMORY_DB_BAK_SUFFIX}`);
}

/**
 * Memory-DB probe order used by every reader that does best-effort detection
 * (statusline, doctor, swarm status, hooks aggregator). Canonical first so
 * the early-break stops at the post-#727 location; legacy paths kept so a
 * partially-migrated consumer still surfaces a result.
 *
 * Keep in sync with the pure-JS twin in `bin/lib/moflo-paths.mjs`.
 */
export function memoryDbCandidatePaths(projectRoot: string): string[] {
  return [
    memoryDbPath(projectRoot),
    legacyMemoryDbPath(projectRoot),
    join(projectRoot, 'data', LEGACY_MEMORY_DB_FILE),
    join(projectRoot, '.claude', LEGACY_MEMORY_DB_FILE),
  ];
}

export interface MigrationResult {
  migrated: boolean;
  /** Diagnostic string for "why didn't this migrate" — `no-legacy`, `legacy-unreadable`, `merged-nothing`. Absent on success. */
  reason?: string;
}

/**
 * One-time migration of `.claude-flow/` → `.moflo/`.
 *
 * - Legacy missing → no-op (the steady state after first run).
 * - Legacy present + target missing → atomic rename (preserves mtimes).
 * - Both present → merge: target wins on collision, leaving the colliding
 *   entry behind in legacy/ so a future run can retry. Drops the legacy dir
 *   if everything moved cleanly.
 *
 * Idempotent and safe to call from session start.
 */
export function migrateClaudeFlowToMoflo(projectRoot: string): MigrationResult {
  const legacy = legacyClaudeFlowDir(projectRoot);
  const target = mofloDir(projectRoot);

  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };

  if (!existsSync(target)) {
    renameSync(legacy, target);
    return { migrated: true };
  }

  let entries: string[];
  try {
    entries = readdirSync(legacy);
  } catch {
    return { migrated: false, reason: 'legacy-unreadable' };
  }

  let moved = 0;
  for (const name of entries) {
    const dst = join(target, name);
    if (existsSync(dst)) continue; // target wins — newer state preferred
    try {
      renameSync(join(legacy, name), dst);
      moved++;
    } catch {
      // Best-effort merge — a failed move on one entry shouldn't abort the rest.
    }
  }

  // Drop empty legacy dir so future runs short-circuit at existsSync(legacy).
  try {
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    // Non-fatal — leftover legacy dir just means migration runs next time.
  }

  return moved > 0 ? { migrated: true } : { migrated: false, reason: 'merged-nothing' };
}

export interface DbMigrationResult {
  migrated: boolean;
  /**
   * Diagnostic string. Absent on success. Possible values:
   * - `no-legacy`           — `.swarm/memory.db` not present (steady state).
   * - `target-exists`       — `.moflo/moflo.db` already there; migration done.
   * - `verify-failed`       — copy completed but byte-equal/sqlite-header check failed.
   * - `copy-failed`         — fs error during copy (disk full, EACCES, lock, …).
   * - `rename-failed`       — copy verified but renaming the source to .bak failed.
   */
  reason?: string;
  /** True when the HNSW sidecar moved alongside the DB. */
  hnswMoved?: boolean;
}

const SQLITE_MAGIC_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function looksLikeSqliteFile(filePath: string): boolean {
  let fd: number | null = null;
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

function verifyByteEqual(srcPath: string, dstPath: string): boolean {
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

function tryUnlink(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* non-fatal */ }
}

/**
 * Move `.swarm/hnsw.index` → `.moflo/hnsw.index` using the same
 * copy-verify-delete pattern as the DB. Returns true on success, false when
 * source absent or copy/verify failed (caller treats as best-effort).
 */
function migrateHnswIndex(projectRoot: string): boolean {
  const src = legacyHnswIndexPath(projectRoot);
  const dst = hnswIndexPath(projectRoot);

  if (!existsSync(src)) return false;
  if (existsSync(dst)) return false; // already there — leave both alone

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

  tryUnlink(src); // sidecar can be regenerated; no .bak retention needed
  return true;
}

/**
 * One-time relocation of the memory DB from the upstream `.swarm/memory.db`
 * layout to the canonical `.moflo/moflo.db` (story #727).
 *
 * Algorithm — copy-verify-delete, never `mv`:
 *   1. If `.moflo/moflo.db` exists → no-op (`target-exists`).
 *   2. If `.swarm/memory.db` absent → no-op (`no-legacy`).
 *   3. Ensure `.moflo/` exists.
 *   4. `copyFileSync(.swarm/memory.db, .moflo/moflo.db)`.
 *   5. Verify byte-equal (size + content) AND SQLite header magic.
 *   6. Move `.swarm/hnsw.index` → `.moflo/hnsw.index` (best-effort).
 *   7. Rename `.swarm/memory.db` → `.swarm/memory.db.bak` (kept one upgrade cycle).
 *
 * Any failure between 4–7 deletes the partial target and returns failure;
 * next session-start retries.
 *
 * MUST run BEFORE any long-lived consumer (MCP server, daemon) opens the DB —
 * sql.js holds a full snapshot in RAM and would clobber the relocated file
 * on its next flush. The launcher's section before the fire-and-forget block
 * is the safe boundary; see feedback memory `feedback_sqljs_writeback_clobber`.
 *
 * Idempotent.
 */
export function migrateMemoryDbToMoflo(projectRoot: string): DbMigrationResult {
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

  // Final step: retire the source by renaming to .bak. Only after the new
  // file is verified — never lose data. If this rename fails we leave the
  // source in place; a stale `.swarm/memory.db` next to a healthy
  // `.moflo/moflo.db` is harmless (the bridge reads only the new path) and
  // surfaces as a `flo doctor` warning.
  try {
    renameSync(source, legacyMemoryDbBakPath(projectRoot));
  } catch {
    return { migrated: true, reason: 'rename-failed', hnswMoved };
  }

  return { migrated: true, hnswMoved };
}
