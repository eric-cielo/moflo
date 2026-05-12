/**
 * Idempotent soft-delete purge for moflo's memory DB (`.moflo/moflo.db`).
 *
 * Story #728 retired soft-delete from the memory layer: tombstones were
 * write-only (no code path ever restored a `status='deleted'` row) and bloated
 * the DB indefinitely. This service hard-deletes any leftover `status='deleted'`
 * rows from prior moflo versions, then VACUUMs to reclaim disk. `archived`
 * rows are NOT touched — they are the legitimate "keep but hide" state and
 * have a working `restore()` path.
 *
 * Lives in `services/` so it has no dependency on the CLI command machinery.
 * That lets `bin/session-start-launcher.mjs` dynamic-import it and run the
 * purge in foreground BEFORE long-lived sql.js consumers (MCP server, daemon)
 * open the DB — sql.js dumps the whole snapshot on every flush and would
 * otherwise clobber our cleanup.
 *
 * @module cli/services/soft-delete-purge
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { memoryDbPath } from './moflo-paths.js';
import { openDaemonDatabase } from '../memory/daemon-backend.js';

export interface PurgeSoftDeletedOptions {
  /** Path to the memory DB. Defaults to `<cwd>/.moflo/moflo.db`. */
  dbPath?: string;
}

export interface PurgeSoftDeletedResult {
  /** Number of `status='deleted'` rows removed. 0 when nothing to purge. */
  purged: number;
}

/**
 * Hard-delete all `status='deleted'` rows from the memory DB and VACUUM.
 *
 * Returns `{ purged: 0 }` for the happy path: no DB, sql.js unavailable,
 * schema lacks `memory_entries`, or no tombstones present. Errors propagate
 * to the caller (the launcher absorbs them so a failed purge never blocks
 * session start).
 */
export async function purgeSoftDeletedEntries(
  options: PurgeSoftDeletedOptions = {},
): Promise<PurgeSoftDeletedResult> {
  const fs = await import('fs');
  const path = await import('path');

  const dbPath = path.resolve(options.dbPath ?? memoryDbPath(process.cwd()));
  if (!fs.existsSync(dbPath)) return { purged: 0 };

  // node:sqlite via the unified factory (Phase 5 / #1084). WAL persists each
  // DELETE/VACUUM incrementally; no atomicWriteFileSync needed.
  const db = openDaemonDatabase(dbPath);

  try {
    // Probe: schema must carry `memory_entries`. Older / non-moflo DBs are
    // a no-op so we don't VACUUM unrelated SQLite files.
    const probe = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) return { purged: 0 };

    // Count first — VACUUM is expensive (it rewrites the whole file), so we
    // skip it entirely when there's nothing to reclaim.
    const countRows = db.exec(
      `SELECT COUNT(*) FROM memory_entries WHERE status = 'deleted'`,
    );
    const purged = Number(countRows[0]?.values?.[0]?.[0] ?? 0);
    if (purged === 0) return { purged: 0 };

    db.run(`DELETE FROM memory_entries WHERE status = 'deleted'`);
    // VACUUM has to run outside any open transaction; node:sqlite/sql.js
    // both auto-commit each `db.run`, so this is safe to chain.
    db.run('VACUUM');

    return { purged };
  } finally {
    db.close();
  }
}
