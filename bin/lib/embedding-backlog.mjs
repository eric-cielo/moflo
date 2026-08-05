/**
 * The embedding backlog predicate — shared by the producer and its gate.
 *
 * Background — issue #1383: `build-embeddings` was gated on the mtime of
 * `.moflo/moflo.db`. That database runs in WAL mode, so the rows the indexer
 * writes land in `moflo.db-wal` and leave `moflo.db`'s mtime untouched. The
 * gate read "unchanged" and skipped the step that embeds rows written seconds
 * earlier in the same chain, leaving chunks with `embedding IS NULL` — present
 * in `memory_entries`, invisible to `memory_search`, with no signal at
 * authoring time. Recovery happened only when a WAL checkpoint incidentally
 * bumped the main file's mtime.
 *
 * The fix is to stop proxying. "Does this step have work?" has an exact,
 * cheap answer in the database, and {@link hasPendingEmbeddings} asks it.
 *
 * The load-bearing property is that {@link PENDING_EMBEDDING_WHERE} is the
 * SAME predicate `build-embeddings.mjs` selects on. A gate that approximates
 * its step's own query is how #1383 happened; if the two ever drift, the gate
 * starts lying again in whichever direction the drift goes. Import the
 * constant — do not restate the clause.
 *
 * @module bin/lib/embedding-backlog
 */

import { existsSync } from 'node:fs';
import { openBackendSync } from './get-backend.mjs';
import { memoryDbPath } from './moflo-paths.mjs';

/**
 * Rows `build-embeddings` will pick up on its next run. Active rows whose
 * embedding is absent — either NULL (never written) or empty string (a
 * producer that failed and wrote a placeholder).
 */
/** Retry budget for the probe's read-only open. See {@link hasPendingEmbeddings}. */
const PROBE_BUSY_TIMEOUT_MS = 2000;

export const PENDING_EMBEDDING_WHERE =
  `status = 'active' AND (embedding IS NULL OR embedding = '')`;

/**
 * Does the memory DB hold rows that still need embedding?
 *
 * Returns `null` — deliberately distinct from `false` — when the question
 * cannot be answered: no DB yet, an unreadable file, a pre-`memory_entries`
 * schema. Callers MUST treat `null` as "don't know" and fall back to their
 * other signals rather than reading it as "no work", because a probe that
 * degrades to `false` on error reintroduces exactly the silent skip #1383 is
 * about.
 *
 * Cost. `EXISTS` short-circuits on the first match, so a store WITH a backlog
 * answers almost immediately. The empty case — the steady state — has no index
 * to use and scans the active rows. Measured on real stores: 12ms at 5.3k rows,
 * 70ms at 32k, i.e. ~2.2µs/row, so a 100k-row consumer pays roughly 200ms.
 * That is affordable because `decideStepGate` calls this only after the
 * fingerprint has already decided to SKIP — the sessions that were going to
 * run the step anyway never pay it — and at most once per session.
 *
 * Not namespace-scoped: `build-embeddings --namespace X` would embed a subset,
 * but the probe answers for the whole store. That can only over-trigger, which
 * the caller's contract permits.
 *
 * @param {string} projectRoot
 * @param {{ dbPath?: string }} [opts]
 * @returns {boolean | null}
 */
export function hasPendingEmbeddings(projectRoot, opts = {}) {
  const dbPath = opts.dbPath || memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    // A small retry budget, not the writer's 15s. The probe races a live
    // daemon often enough that failing instantly would answer `null` at the
    // moment it matters most, but it sits in the session-start critical path
    // and the fingerprint backstops a `null` — so it waits a beat, not a
    // quarter of a minute.
    db = openBackendSync(projectRoot, { dbPath, readOnly: true, busyTimeoutMs: PROBE_BUSY_TIMEOUT_MS });
  } catch {
    return null;
  }

  try {
    const rows = db.exec(
      `SELECT EXISTS(SELECT 1 FROM memory_entries WHERE ${PENDING_EMBEDDING_WHERE}) AS pending`,
    );
    const value = rows?.[0]?.values?.[0]?.[0];
    if (value === undefined || value === null) return null;
    return Number(value) > 0;
  } catch {
    // Missing table / older schema / concurrent writer holding a lock past the
    // busy timeout — all "don't know", never "no work".
    return null;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}
