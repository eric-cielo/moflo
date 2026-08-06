/**
 * Migration: hard-delete SDD spec/plan chunks from the `guidance` namespace.
 *
 * `bin/index-guidance.mjs` used to index `<specs_dir>/<slug>/{spec,plan}.md`
 * into `guidance` alongside real project guidance (Epic #1269, `kind: 'spec'`).
 * A spec is pre-implementation intent for one unit of work, not a project rule:
 * once implemented it is stale-by-construction, and specs accumulate without
 * bound, so the namespace degraded monotonically with project age. The indexer
 * now excludes the specs directory outright.
 *
 * This clears what earlier versions already wrote. Two shapes existed:
 *
 *   1. `chunk-spec-*` keys with `metadata.kind === 'spec'` — the dedicated
 *      step-6 path, used when `specs_dir` sat OUTSIDE every guidance directory.
 *   2. Ordinary guidance chunks under a guidance prefix — produced when
 *      `specs_dir` sat INSIDE a guidance dir (the config `moflo-sdd.md`
 *      recommends for reviewable specs). These carry no spec marker at all and
 *      are indistinguishable from real guidance by key or metadata.
 *
 * Only shape 1 is purged here, because it is the only one that can be
 * identified without guessing. Shape 2 is handled by the repaired stale sweep
 * in `bin/index-guidance.mjs`: the specs directory is now pruned from the walk,
 * so those chunk prefixes fall out of the live set on the next index run and
 * are swept as deleted files. Deleting them here by path-matching would risk
 * taking real guidance with them.
 *
 * Idempotent: re-runs find no matching rows.
 *
 * @module bin/migrations/purge-spec-chunks
 */

import { existsSync } from 'fs';
import { memoryDbPath } from '../lib/moflo-paths.mjs';
import { openBackend } from '../lib/get-backend.mjs';

export const name = 'purge-spec-chunks';
// After purge-doc-entries (0) and strip-context-preambles (20) so this operates
// on an already-normalised chunk table.
export const order = 30;

/**
 * @param {string} projectRoot
 * @returns {Promise<{purged:number}>}
 */
export async function run(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { purged: 0 };

  const db = await openBackend(projectRoot, { create: false });

  // Two independent markers, OR'd, because they were written by the same code
  // path and either alone would leave rows behind on a partial index:
  //   - key prefix `chunk-spec-` (dirConfig.prefix === 'spec')
  //   - metadata.kind === 'spec' (survives even if the prefix ever changed)
  // Scoped to `guidance` — the only namespace bin/index-guidance.mjs writes —
  // so a user-stored entry elsewhere that happens to match is never touched.
  const WHERE = `namespace = 'guidance'
      AND (key LIKE 'chunk-spec-%' OR metadata LIKE '%"kind":"spec"%')`;

  const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM memory_entries WHERE ${WHERE}`);
  countStmt.step();
  const beforeCount = Number(countStmt.getAsObject().cnt ?? 0);
  countStmt.free();

  if (beforeCount === 0) {
    db.close();
    return { purged: 0 };
  }

  db.run(`DELETE FROM memory_entries WHERE ${WHERE}`);
  const purged = db.getRowsModified?.() ?? beforeCount;

  // No explicit HNSW invalidation needed: the delete moves the DB/WAL mtime,
  // which is exactly what the `hnsw-rebuild` step gates on, so the sidecar
  // reconciles on the next session-start indexer pass.
  if (purged > 0) db.save();
  db.close();
  return { purged };
}
