/**
 * Migration: hard-delete every legacy `knowledge`-namespace row whose
 * counterpart now exists in `learnings` (tagged `migratedFrom:knowledge`).
 *
 * Runs AFTER `knowledge-to-learnings` (manifest gate). For each `knowledge`
 * row (active or archived):
 *   - counterpart present  → hard-delete
 *   - counterpart missing  → skip with stderr warning (defensive — should
 *     not happen post-`knowledge-to-learnings`; existing consumers stuck on
 *     the active-only v1 will see this for archived rows the original missed)
 *
 * The deprecated-alias soft-redirect at `storeEntry` stays — any caller still
 * passing `namespace: 'knowledge'` writes lands transparently in `learnings`.
 *
 * @module bin/migrations/knowledge-purge
 */

import { existsSync } from 'fs';
import { memoryDbPath } from '../lib/moflo-paths.mjs';
import { openBackend } from '../lib/get-backend.mjs';
import { hasMigrationRun } from '../lib/migrations.mjs';
import { MIGRATED_FROM_KNOWLEDGE } from './lib/markers.mjs';

export const name = 'knowledge-purge';
// Explicit ordering puts this after `knowledge-to-learnings` (default order=0)
// in the runner's queue so a single session-start completes the pipeline. The
// manifest gate inside `run()` is the cross-session safety net: if the
// consolidation copy errored mid-run, the manifest is unstamped and we defer
// the purge until a future session lands the copy successfully.
export const order = 10;

/**
 * @param {string} projectRoot
 * @returns {Promise<{purged:number, skipped:number}>}
 */
export async function run(projectRoot) {
  // Manifest gate: only run after the consolidation copy completed. Throwing
  // (rather than returning {skipped:true}) keeps the manifest unstamped so
  // we retry next session — the runner records done only on resolved returns.
  if (!hasMigrationRun(projectRoot, 'knowledge-to-learnings')) {
    throw new Error('knowledge-to-learnings has not yet completed; will retry next session');
  }

  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { purged: 0, skipped: 0 };

  // Lazy-load via the backend factory — keeps the manifest-stamped no-op
  // path off the WASM init cost (~30ms cold) and lets the engine swap via
  // MOFLO_DB_BACKEND.
  const db = await openBackend(projectRoot, { create: false });

  const knowledgeStmt = db.prepare(
    `SELECT id, key, status FROM memory_entries
     WHERE namespace = 'knowledge' AND status IN ('active','archived')`,
  );
  const knowledgeRows = [];
  while (knowledgeStmt.step()) knowledgeRows.push(knowledgeStmt.getAsObject());
  knowledgeStmt.free();

  if (knowledgeRows.length === 0) {
    db.close();
    return { purged: 0, skipped: 0 };
  }

  // tags is a JSON-encoded array string — LIKE on the substring is enough to
  // confirm the migratedFrom:knowledge marker without parsing every row. The
  // marker is a JS-defined constant, not user input, so inlining via template
  // literal avoids sql.js's two-step prepare+bind for a single-shot read.
  const counterpartStmt = db.prepare(
    `SELECT key FROM memory_entries
     WHERE namespace = 'learnings'
       AND status IN ('active','archived')
       AND tags LIKE '%${MIGRATED_FROM_KNOWLEDGE}%'`,
  );
  const migratedKeys = new Set();
  while (counterpartStmt.step()) migratedKeys.add(String(counterpartStmt.getAsObject().key));
  counterpartStmt.free();

  const deleteStmt = db.prepare(`DELETE FROM memory_entries WHERE id = ?`);

  let purged = 0;
  let skipped = 0;
  try {
    for (const row of knowledgeRows) {
      const key = String(row.key);
      if (!migratedKeys.has(key)) {
        skipped++;
        // One-line stderr warning per ticket — defensive, should not fire on
        // a healthy DB. archived-row orphans on consumers stuck on v1 surface
        // here so the user has a paper trail.
        process.stderr.write(
          `[migrations]   knowledge-purge: skipping orphan key="${key}" status=${row.status} (no ${MIGRATED_FROM_KNOWLEDGE} counterpart)\n`,
        );
        continue;
      }
      deleteStmt.run([row.id]);
      purged++;
    }
  } finally {
    deleteStmt.free();
  }

  if (purged > 0) db.save();
  db.close();
  return { purged, skipped };
}
