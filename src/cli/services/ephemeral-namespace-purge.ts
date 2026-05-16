/**
 * Idempotent session-start memory cleanup for moflo's memory DB
 * (`.moflo/moflo.db`).
 *
 * Two passes run in a single sql.js open:
 *
 * 1. **Hard-purge** namespaces in {@link PURGE_ON_SESSION_START_NAMESPACES} —
 *    `hive-mind`, `epic-state`, `test-bridge-fix`. These store internal
 *    run-tracking that does not need to survive a session restart. (#729)
 *
 * 2. **Retention trim** the `tasklist` namespace down to the most recent
 *    {@link TASKLIST_RETENTION_CAP} rows. `tasklist` is the dashboard's
 *    "Flo Runs" tab data source (`daemon-dashboard.ts handleSpells`); the
 *    pre-#968 contract hard-purged it on every session start, leaving the tab
 *    permanently empty. Trim instead so users see recent history without
 *    unbounded growth.
 *
 * Both passes share the file open + final VACUUM + atomic write, so disk I/O
 * is the same as before. Writes back to disk only when something changed.
 *
 * Lives in `services/` so it has no dependency on the CLI command machinery.
 * That lets `bin/session-start-launcher.mjs` dynamic-import it and run in
 * foreground BEFORE long-lived sql.js consumers (MCP server, daemon) open
 * the DB — sql.js dumps the whole snapshot on every flush and would
 * otherwise clobber our cleanup (see #727's clobber-hazard analysis).
 *
 * @module cli/services/ephemeral-namespace-purge
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  PURGE_ON_SESSION_START_NAMESPACES,
  PURGE_ON_SESSION_START_PREFIXES,
  TASKLIST_RETENTION_CAP,
} from '../memory/bridge-embedder.js';
import { memoryDbPath } from './moflo-paths.js';
import { openDaemonDatabase } from '../memory/daemon-backend.js';

export interface PurgeEphemeralNamespacesOptions {
  /** Path to the memory DB. Defaults to `<cwd>/.moflo/moflo.db`. */
  dbPath?: string;
  /**
   * Override the tasklist retention cap. Defaults to
   * {@link TASKLIST_RETENTION_CAP}. Tests use this to drive the trim path
   * without seeding hundreds of rows.
   */
  tasklistRetentionCap?: number;
}

export interface PurgeEphemeralNamespacesResult {
  /** Number of rows hard-deleted from {@link PURGE_ON_SESSION_START_NAMESPACES}. */
  purged: number;
  /** Number of `tasklist` rows trimmed by the retention pass. */
  trimmed: number;
}

/**
 * Hard-delete rows in {@link PURGE_ON_SESSION_START_NAMESPACES} and trim the
 * `tasklist` namespace to its retention cap, then VACUUM. Returns
 * `{ purged: 0, trimmed: 0 }` on the happy path: no DB, sql.js unavailable,
 * schema lacks `memory_entries`, or nothing to clean. Errors propagate to
 * the caller (the launcher absorbs them so a failed purge never blocks
 * session start).
 */
export async function purgeEphemeralNamespaces(
  options: PurgeEphemeralNamespacesOptions = {},
): Promise<PurgeEphemeralNamespacesResult> {
  const fs = await import('fs');
  const path = await import('path');

  const dbPath = path.resolve(options.dbPath ?? memoryDbPath(process.cwd()));
  if (!fs.existsSync(dbPath)) return { purged: 0, trimmed: 0 };

  // node:sqlite via the unified factory (Phase 5 / #1084). WAL persists each
  // DELETE/VACUUM incrementally; no atomicWriteFileSync needed.
  const db = openDaemonDatabase(dbPath);

  try {
    // Probe: schema must carry `memory_entries`. Older / non-moflo DBs are
    // a no-op so we don't VACUUM unrelated SQLite files.
    const probe = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) return { purged: 0, trimmed: 0 };

    // Single COUNT pass to gate both DELETEs — a clean DB is the steady
    // state and we don't want two no-op DELETEs (with their query-planner
    // overhead) on every session start.
    //
    // Match shape: exact namespace IN (...) OR namespace LIKE 'prefix-%'.
    // The prefix clause covers runtime-suffixed namespaces like
    // `doctor-memprobe-<persona>` whose set of suffixes isn't known upfront.
    const namespaces = Array.from(PURGE_ON_SESSION_START_NAMESPACES);
    const prefixes = Array.from(PURGE_ON_SESSION_START_PREFIXES);
    const cap = options.tasklistRetentionCap ?? TASKLIST_RETENTION_CAP;

    const exactClause = namespaces.length
      ? `namespace IN (${namespaces.map(() => '?').join(', ')})`
      : '0';
    const prefixClause = prefixes.map(() => 'namespace LIKE ?').join(' OR ');
    const purgeWhere = prefixClause ? `(${exactClause} OR ${prefixClause})` : exactClause;
    const purgeBindings = [...namespaces, ...prefixes.map((p) => `${p}%`)];

    const countRows = db.exec(
      `SELECT
         (SELECT COUNT(*) FROM memory_entries WHERE ${purgeWhere}) AS purgeable,
         (SELECT COUNT(*) FROM memory_entries WHERE namespace = 'tasklist') AS tasklistTotal`,
      purgeBindings,
    );
    const counts = countRows[0]?.values?.[0] ?? [0, 0];
    const purgeable = Number(counts[0] ?? 0);
    const tasklistTotal = Number(counts[1] ?? 0);

    let purged = 0;
    if (purgeable > 0) {
      db.run(
        `DELETE FROM memory_entries WHERE ${purgeWhere}`,
        purgeBindings,
      );
      purged = db.getRowsModified?.() ?? 0;
    }

    let trimmed = 0;
    if (tasklistTotal > cap) {
      // Keep the newest `cap` rows by created_at, falling back to `id DESC`
      // for legacy rows that predate the created_at-not-null schema (#728-era).
      db.run(
        `DELETE FROM memory_entries
         WHERE namespace = 'tasklist'
           AND id NOT IN (
             SELECT id FROM memory_entries
             WHERE namespace = 'tasklist'
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )`,
        [cap],
      );
      trimmed = db.getRowsModified?.() ?? 0;
    }

    if (purged === 0 && trimmed === 0) return { purged: 0, trimmed: 0 };

    // VACUUM has to run outside any open transaction; node:sqlite/sql.js
    // both auto-commit each `db.run`, so this is safe to chain.
    db.run('VACUUM');

    return { purged, trimmed };
  } finally {
    db.close();
  }
}

export interface PurgeMemoryProbeNamespacesOptions {
  /** Path to the memory DB. Defaults to `<cwd>/.moflo/moflo.db`. */
  dbPath?: string;
}

/**
 * Hard-delete rows whose namespace matches one of
 * {@link PURGE_ON_SESSION_START_PREFIXES} — currently `doctor-memprobe-*`
 * and `doctor-neighbors-*`. Scoped down from {@link purgeEphemeralNamespaces}:
 * no exact-namespace pass, no tasklist trim, no VACUUM. Returns
 * `{ purged: 0 }` on a missing DB / missing `memory_entries` / clean state.
 *
 * Intended for the doctor's Memory Access functional check finally block
 * (#1166). Only the doctor writes to these namespaces in production, so
 * sweeping by prefix at the end of every healer run kills the
 * `populated:ephemeral-purged` flake class — a per-key `safeDelete` that
 * silently no-ops (row not visible at delete time, MCP transport error,
 * `memory_delete` returning `success: true, deleted: false`) no longer
 * leaks a row into the next assertion. The launcher's session-start
 * purge stays in place as a defence-in-depth safety net for residue from
 * crashed-process scenarios where the doctor never reached its finally.
 *
 * Errors propagate to the caller (the doctor absorbs them so a failed
 * sweep never poisons the check return value).
 */
export async function purgeMemoryProbeNamespaces(
  options: PurgeMemoryProbeNamespacesOptions = {},
): Promise<{ purged: number }> {
  const fs = await import('fs');
  const path = await import('path');

  const dbPath = path.resolve(options.dbPath ?? memoryDbPath(process.cwd()));
  if (!fs.existsSync(dbPath)) return { purged: 0 };

  const prefixes = Array.from(PURGE_ON_SESSION_START_PREFIXES);
  if (prefixes.length === 0) return { purged: 0 };

  const db = openDaemonDatabase(dbPath);
  try {
    const probe = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) return { purged: 0 };

    const whereClause = prefixes.map(() => 'namespace LIKE ?').join(' OR ');
    const bindings = prefixes.map((p) => `${p}%`);

    const countRows = db.exec(
      `SELECT COUNT(*) FROM memory_entries WHERE ${whereClause}`,
      bindings,
    );
    const purgeable = Number(countRows[0]?.values?.[0]?.[0] ?? 0);
    if (purgeable === 0) return { purged: 0 };

    db.run(`DELETE FROM memory_entries WHERE ${whereClause}`, bindings);
    return { purged: db.getRowsModified?.() ?? 0 };
  } finally {
    db.close();
  }
}
