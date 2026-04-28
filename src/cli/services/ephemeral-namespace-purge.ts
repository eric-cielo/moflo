/**
 * Idempotent ephemeral-namespace purge for moflo's memory DB (`.moflo/moflo.db`).
 *
 * Story #729 retired four namespaces from the persistent memory layer because
 * they store internal moflo run-tracking — not user knowledge — and embedding
 * them polluted the search index:
 *
 *  - `hive-mind`        (MCP broadcast traffic)
 *  - `tasklist`         (spell run records)
 *  - `epic-state`       (epic progress tracking)
 *  - `test-bridge-fix`  (single-row leftover from a one-off test)
 *
 * This service hard-deletes any rows in those namespaces left over from prior
 * moflo versions, then VACUUMs to reclaim disk. Future writes to these
 * namespaces still land in the DB — but skip embedding generation entirely
 * (see {@link EPHEMERAL_NAMESPACES} in `memory/bridge-embedder.ts`).
 *
 * Lives in `services/` so it has no dependency on the CLI command machinery.
 * That lets `bin/session-start-launcher.mjs` dynamic-import it and run the
 * purge in foreground BEFORE long-lived sql.js consumers (MCP server, daemon)
 * open the DB — sql.js dumps the whole snapshot on every flush and would
 * otherwise clobber our cleanup (see #727's clobber-hazard analysis).
 *
 * @module cli/services/ephemeral-namespace-purge
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EPHEMERAL_NAMESPACES } from '../memory/bridge-embedder.js';
import { mofloImport } from './moflo-require.js';
import { atomicWriteFileSync } from './atomic-file-write.js';
import { memoryDbPath } from './moflo-paths.js';

export interface PurgeEphemeralNamespacesOptions {
  /** Path to the memory DB. Defaults to `<cwd>/.moflo/moflo.db`. */
  dbPath?: string;
}

export interface PurgeEphemeralNamespacesResult {
  /** Number of rows hard-deleted across all ephemeral namespaces. 0 when nothing to purge. */
  purged: number;
}

/**
 * Hard-delete every row whose namespace is in {@link EPHEMERAL_NAMESPACES}
 * and VACUUM. Returns `{ purged: 0 }` on the happy path: no DB, sql.js
 * unavailable, schema lacks `memory_entries`, or no ephemeral rows present.
 * Errors propagate to the caller (the launcher absorbs them so a failed
 * purge never blocks session start).
 */
export async function purgeEphemeralNamespaces(
  options: PurgeEphemeralNamespacesOptions = {},
): Promise<PurgeEphemeralNamespacesResult> {
  const fs = await import('fs');
  const path = await import('path');

  const dbPath = path.resolve(options.dbPath ?? memoryDbPath(process.cwd()));
  if (!fs.existsSync(dbPath)) return { purged: 0 };

  const initSqlJs = (await mofloImport('sql.js'))?.default;
  if (!initSqlJs) return { purged: 0 };

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  try {
    // Probe: schema must carry `memory_entries`. Older / non-moflo DBs are
    // a no-op so we don't VACUUM unrelated SQLite files.
    const probe = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) return { purged: 0 };

    const namespaces = Array.from(EPHEMERAL_NAMESPACES);
    const placeholders = namespaces.map(() => '?').join(', ');

    // Single-scan delete + rowsModified: skips a redundant COUNT pass on dirty
    // DBs and avoids the prepare/bind/step/free overhead on clean ones. VACUUM
    // (and the disk write) only run when something was actually deleted.
    db.run(
      `DELETE FROM memory_entries WHERE namespace IN (${placeholders})`,
      namespaces,
    );
    const purged = db.getRowsModified?.() ?? 0;
    if (purged === 0) return { purged: 0 };

    // VACUUM has to run outside any open transaction; sql.js auto-commits
    // each `db.run`, so this is safe to chain.
    db.run('VACUUM');

    atomicWriteFileSync(dbPath, db.export());
    return { purged };
  } finally {
    db.close();
  }
}
