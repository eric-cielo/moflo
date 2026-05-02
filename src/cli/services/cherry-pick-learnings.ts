/**
 * Selective cherry-pick of durable memory rows on upgrade (#851).
 *
 * Replaces the full-DB byte-copy migration that epic #726 / story #727
 * shipped (`migrateMemoryDbToMoflo`). That approach moved the entire 50+ MB
 * of accumulated memory state across paths, then left the daemon writing to
 * stale paths from its in-memory module cache. The user-visible result was
 * "git went haywire" — see docs/moflo-4.9.1-upgrade-experience-2026-05-02.md.
 *
 * Almost all DB content is derived (code-map, embeddings, patterns, guidance
 * chunks) and rebuilds on demand from the indexers. Only the `learnings`
 * and `knowledge` namespaces are user-authored and worth carrying forward
 * across upgrades. Everything else is regenerated cheaply.
 *
 * Algorithm:
 *   1. Probe legacy DB candidates (`.swarm/memory.db.bak`, `.swarm/memory.db`,
 *      etc.) read-only — sources are NEVER mutated.
 *   2. Ensure the target `.moflo/moflo.db` exists with V3 schema (idempotent
 *      `CREATE TABLE IF NOT EXISTS`).
 *   3. `SELECT … WHERE namespace IN ('learnings', 'knowledge')` from each
 *      legacy source.
 *   4. `INSERT OR IGNORE INTO memory_entries` keyed on the existing
 *      `UNIQUE(namespace, key)` constraint — duplicates skip silently, which
 *      is what makes a re-run of an interrupted migration safe.
 *   5. `atomicWriteFileSync` the target so a SIGINT mid-flush can't truncate.
 *
 * Caller (the launcher) is responsible for stopping the daemon before this
 * runs — sql.js holds a full snapshot in memory and a concurrent flush from
 * a stale daemon would clobber the cherry-picked rows.
 *
 * @module cli/services/cherry-pick-learnings
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import { mofloImport } from './moflo-require.js';
import { atomicWriteFileSync } from './atomic-file-write.js';
import {
  legacyMemoryDbBakPath,
  memoryDbCandidatePaths,
  memoryDbPath,
} from './moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../memory/memory-initializer.js';

/** Namespaces preserved across upgrades. Everything else is derived. */
export const DURABLE_NAMESPACES = ['learnings', 'knowledge'] as const;

/**
 * Reasons a single source contributed zero rows. Exported so callers can
 * branch on the cause without duplicating string literals.
 */
export const CHERRY_PICK_SKIP_REASONS = {
  OPEN_FAILED: 'open-failed',
  SCHEMA_MISMATCH: 'schema-mismatch',
  NO_ROWS: 'no-rows',
  SELF_REFERENCE: 'self-reference',
} as const;
export type CherryPickSkipReason =
  (typeof CHERRY_PICK_SKIP_REASONS)[keyof typeof CHERRY_PICK_SKIP_REASONS];

export interface CherryPickOptions {
  projectRoot?: string;
  /**
   * Override the legacy source candidates. Each path is opened read-only and
   * skipped if absent / unreadable / wrong schema. Tests pass an explicit list;
   * the launcher relies on the default candidate order.
   */
  legacyPaths?: string[];
  toPath?: string;
  namespaces?: readonly string[];
}

export interface CherryPickSourceReport {
  path: string;
  rowsRead: number;
  rowsInserted: number;
  reason?: CherryPickSkipReason;
}

export interface CherryPickResult {
  copied: number;
  considered: number;
  sources: CherryPickSourceReport[];
  target: string;
}

/**
 * Composed off `memoryDbCandidatePaths` so any future addition there
 * (statusline, doctor, etc. all share that probe order) automatically
 * extends the cherry-pick. The `.bak` path is added at highest priority
 * because it's the post-#727 migration backup and ranks above the live
 * legacy file. The canonical `.moflo/moflo.db` is dropped — the
 * self-reference guard would skip it anyway, and including it would just
 * confuse the report.
 */
function defaultLegacyCandidates(projectRoot: string): string[] {
  const canonical = memoryDbPath(projectRoot);
  const tail = memoryDbCandidatePaths(projectRoot).filter((p) => p !== canonical);
  return [legacyMemoryDbBakPath(projectRoot), ...tail];
}

/**
 * Cherry-pick durable memory rows from any legacy DBs into `.moflo/moflo.db`.
 *
 * Returns a report — never throws on per-source failures. The caller (launcher)
 * surfaces the count via `emitMutation`; a missing source / schema mismatch /
 * locked file is recorded in `sources[].reason` and the upgrade continues.
 *
 * Hard failures (sql.js unavailable, target write failure) propagate so the
 * launcher can choose to swallow + retry next session-start.
 */
export async function cherryPickLearningsFromLegacy(
  options: CherryPickOptions = {},
): Promise<CherryPickResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const target = path.resolve(options.toPath ?? memoryDbPath(projectRoot));
  const namespaces = options.namespaces ?? DURABLE_NAMESPACES;
  const legacyPaths = (options.legacyPaths ?? defaultLegacyCandidates(projectRoot)).map((p) =>
    path.resolve(p),
  );

  const result: CherryPickResult = {
    copied: 0,
    considered: 0,
    sources: [],
    target,
  };

  const initSqlJs = (await mofloImport('sql.js'))?.default;
  if (!initSqlJs) return result;

  const SQL = (await initSqlJs()) as any;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const targetExists = fs.existsSync(target);
  const targetDb = targetExists
    ? new SQL.Database(fs.readFileSync(target))
    : new SQL.Database();

  let insertStmt: any = null;
  try {
    targetDb.run(MEMORY_SCHEMA_V3);

    const placeholders = namespaces.map(() => '?').join(',');
    const selectSql =
      `SELECT id, key, namespace, content, type, embedding, embedding_model, ` +
      `embedding_dimensions, tags, metadata, owner_id, created_at, updated_at, status ` +
      `FROM memory_entries WHERE namespace IN (${placeholders})`;
    // Hoisted prepare — avoids re-parsing the SQL inside sql.js for every
    // INSERT. Matters for legacy DBs with hundreds of learnings rows.
    insertStmt = targetDb.prepare(
      `INSERT OR IGNORE INTO memory_entries ` +
        `(id, key, namespace, content, type, embedding, embedding_model, ` +
        ` embedding_dimensions, tags, metadata, owner_id, created_at, updated_at, status) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const sourcePath of legacyPaths) {
      if (sourcePath === target) {
        result.sources.push({
          path: sourcePath,
          rowsRead: 0,
          rowsInserted: 0,
          reason: CHERRY_PICK_SKIP_REASONS.SELF_REFERENCE,
        });
        continue;
      }
      if (!fs.existsSync(sourcePath)) continue;

      const report = readAndInsert(SQL, sourcePath, targetDb, insertStmt, selectSql, namespaces);
      result.sources.push(report);
      result.copied += report.rowsInserted;
      result.considered += report.rowsRead;
    }

    // Skip the atomic write when there's nothing to persist:
    //  - copied=0 + target didn't exist → don't materialize an empty DB
    //    (the regular initializer creates it on first real write).
    //  - copied=0 + target already existed → no diff, nothing to flush.
    if (result.copied > 0) {
      atomicWriteFileSync(target, Buffer.from(targetDb.export()));
    }
  } finally {
    if (insertStmt) {
      try { insertStmt.free(); } catch { /* best-effort cleanup */ }
    }
    targetDb.close();
  }

  return result;
}

function readAndInsert(
  SQL: any,
  sourcePath: string,
  targetDb: any,
  insertStmt: any,
  selectSql: string,
  namespaces: readonly string[],
): CherryPickSourceReport {
  let sourceDb: any;
  try {
    sourceDb = new SQL.Database(fs.readFileSync(sourcePath));
  } catch {
    return {
      path: sourcePath,
      rowsRead: 0,
      rowsInserted: 0,
      reason: CHERRY_PICK_SKIP_REASONS.OPEN_FAILED,
    };
  }

  try {
    // Older / unrelated DBs may not have memory_entries.
    const probe = sourceDb.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) {
      return {
        path: sourcePath,
        rowsRead: 0,
        rowsInserted: 0,
        reason: CHERRY_PICK_SKIP_REASONS.SCHEMA_MISMATCH,
      };
    }

    let rowsRead = 0;
    let rowsInserted = 0;
    const selectStmt = sourceDb.prepare(selectSql);
    selectStmt.bind(namespaces.slice());
    while (selectStmt.step()) {
      rowsRead++;
      const row = selectStmt.getAsObject();
      insertStmt.bind([
        row.id,
        row.key,
        row.namespace,
        row.content,
        row.type ?? 'semantic',
        row.embedding ?? null,
        row.embedding_model ?? null,
        row.embedding_dimensions ?? null,
        row.tags ?? null,
        row.metadata ?? null,
        row.owner_id ?? null,
        row.created_at ?? null,
        row.updated_at ?? null,
        row.status ?? 'active',
      ]);
      insertStmt.step();
      if (targetDb.getRowsModified() > 0) rowsInserted++;
      insertStmt.reset();
    }
    selectStmt.free();
    return {
      path: sourcePath,
      rowsRead,
      rowsInserted,
      reason: rowsRead === 0 ? CHERRY_PICK_SKIP_REASONS.NO_ROWS : undefined,
    };
  } finally {
    sourceDb.close();
  }
}
