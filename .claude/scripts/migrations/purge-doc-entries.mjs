/**
 * Migration: hard-delete every legacy `doc-*` whole-document entry from the
 * guidance namespace. The chunker no longer writes these (#1053 S4) — audit
 * found zero production readers, they duplicated chunk semantic territory,
 * and they ate ~13% of search slots on every query without unique signal.
 *
 * Idempotent: re-runs are no-ops because there will be no `doc-*` rows left.
 *
 * @module bin/migrations/purge-doc-entries
 */

import { existsSync } from 'fs';
import { memoryDbPath } from '../lib/moflo-paths.mjs';
import { openBackend } from '../lib/get-backend.mjs';

export const name = 'purge-doc-entries';

/**
 * @param {string} projectRoot
 * @returns {Promise<{purged:number}>}
 */
export async function run(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { purged: 0 };

  // Lazy-load via the backend factory — keeps the manifest-stamped no-op
  // path off the WASM init cost (~30ms cold) and lets the engine swap via
  // MOFLO_DB_BACKEND.
  const db = await openBackend(projectRoot, { create: false });

  // Scope: every namespace, since both `flo memory index-guidance` and
  // `bin/index-guidance.mjs` historically wrote doc-* across whatever
  // namespace the entry was scoped to (default for guidance: `guidance`).
  // Conservative — match the prefix only, never sweep user-stored keys
  // that happen to start with "doc".
  const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM memory_entries WHERE key LIKE 'doc-%'`);
  countStmt.step();
  const beforeCount = Number(countStmt.getAsObject().cnt ?? 0);
  countStmt.free();

  if (beforeCount === 0) {
    db.close();
    return { purged: 0 };
  }

  db.run(`DELETE FROM memory_entries WHERE key LIKE 'doc-%'`);
  const purged = db.getRowsModified?.() ?? beforeCount;

  if (purged > 0) db.save();
  db.close();
  return { purged };
}
