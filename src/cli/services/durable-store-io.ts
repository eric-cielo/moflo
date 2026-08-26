/**
 * Reading durable rows out of a memory DB and applying a reconciliation plan
 * back into one (#1463).
 *
 * The merge rule itself lives in {@link module:cli/services/durable-reconcile}
 * and knows nothing about SQLite. This module is the other half: the SQL that
 * turns `memory_entries` into {@link ReconcileRecord}s and the SQL that applies
 * the resulting {@link ReconcileAction}s. Both the team JSONL artifact
 * (`team-artifact-sync.ts`) and the worktree/cross-install durable sync
 * (`durable-sync.ts`) use it, so the DB half of the sync exists once.
 *
 * ## Deletions are archives, not DELETEs
 *
 * A hard-deleted row is indistinguishable from a row that never existed, so it
 * can never propagate — and "delete anything the other side lacks" is the rule
 * we must not adopt (see the reconcile module header). Durable deletions
 * therefore set `status = 'archived'` and stamp `updated_at` with the deletion
 * time. Nothing else has to change for that to be invisible: every read path in
 * moflo already filters `status = 'active'` — search, list, stats, retrieve,
 * cleanup, and the HNSW index build. The archived row survives only as the
 * evidence that lets the deletion cross to another store, and as the timestamp
 * that lets a legitimate re-creation win later.
 *
 * ## Writer classification
 *
 * `daemon-offline`, same shape as `cherry-pick-learnings.ts` and the existing
 * team-artifact import: these run pre-boot at session-start or from a CLI
 * command, not concurrently with a live daemon writer. Registered in
 * `tests/system/fixtures/writer-audit-whitelist.json` (#1054).
 *
 * @module cli/services/durable-store-io
 */

import { MEMORY_SCHEMA_V3 } from '../memory/schema.js';
import type { SqlJsLikeDatabase } from '../memory/daemon-backend.js';
import {
  DURABLE_NAMESPACES,
  DURABLE_INSERT_OR_IGNORE_SQL,
  DURABLE_ROW_COLUMNS,
  hasMemoryEntriesTable,
  isDurableNamespace,
} from './cherry-pick-learnings.js';

// Re-exported so the two delete paths (`entries-write`, `bridge-entries`) can
// reach the durable check and the archive statement through ONE import,
// rather than each assembling its own copy of the retire-a-durable-row rule.
export { isDurableNamespace };
import {
  reconcileId,
  type ReconcileAction,
  type ReconcileRecord,
} from './durable-reconcile.js';

/** The `status` value that marks a durable row as deleted-but-propagatable. */
export const ARCHIVED_STATUS = 'archived';

/**
 * A full durable row, carrying everything an insert or update needs. The
 * reconcile plan compares only {@link ReconcileRecord}s; this is what the
 * caller looks up by the same id when applying an action.
 */
export interface DurablePayload {
  id: string;
  namespace: string;
  key: string;
  content: string;
  type: string;
  /** JSON-encoded array, or null. Stored verbatim — never re-parsed here. */
  tags: string | null;
  metadata: string | null;
  ownerId: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * JSON-encoded vector, or null to have the daemon's index pass regenerate it.
   * A caller whose content came from somewhere the embedding does NOT match
   * (the JSONL artifact carries no vectors) must pass null — a stale vector
   * would leave the row findable under its old meaning.
   */
  embedding: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
}

export interface DurableSnapshot {
  /** What the merge rule compares. Includes archived rows, as tombstones. */
  records: Map<string, ReconcileRecord>;
  /** The same rows in full, for the caller to hand back when applying. */
  payloads: Map<string, DurablePayload>;
}

// Same column list as the shared INSERT, so a future column can never be added
// to one half of the round trip only. The status filter is what differs from
// the legacy cherry-pick read: archived rows are the deletions we must carry.
const selectDurableSql = (placeholders: string, columns: string, byKey: boolean): string =>
  `SELECT ${columns} FROM memory_entries ` +
  `WHERE namespace IN (${placeholders}) AND status IN ('active', '${ARCHIVED_STATUS}')` +
  (byKey ? ` AND key = ?` : '');

/**
 * The columns the merge rule alone needs. A comparison never looks at the
 * embedding, and on a 1,600-row store those JSON vectors are tens of MB of
 * string allocation — so the side of a sync that only supplies records (the
 * TARGET, always) must not pay for them.
 */
const RECORD_ONLY_COLUMNS = `key, namespace, content, updated_at, status`;

export interface SnapshotOptions {
  /**
   * Build the full {@link DurablePayload} map too. Only the SOURCE of a sync
   * needs it — payloads are what gets written into the target. Defaults false.
   */
  withPayloads?: boolean;
  /** Restrict the read to one key. Used by the per-write flush, which knows exactly what changed. */
  key?: string;
}

/**
 * Read the durable slice of a DB into comparable records plus full payloads.
 * An archived row becomes a tombstone stamped with its `updated_at` — which is
 * the deletion time, because that is what the archive write sets.
 *
 * Returns empty maps for a DB with no `memory_entries` table rather than
 * throwing: a not-yet-initialised store is "nothing to sync", not an error.
 */
export function readDurableSnapshot(
  db: SqlJsLikeDatabase,
  namespaces: readonly string[] = DURABLE_NAMESPACES,
  opts: SnapshotOptions = {},
): DurableSnapshot {
  const records = new Map<string, ReconcileRecord>();
  const payloads = new Map<string, DurablePayload>();
  if (!hasMemoryEntriesTable(db)) return { records, payloads };

  const withPayloads = opts.withPayloads === true;
  const placeholders = namespaces.map(() => '?').join(',');
  const stmt = db.prepare(
    selectDurableSql(placeholders, withPayloads ? DURABLE_ROW_COLUMNS : RECORD_ONLY_COLUMNS, opts.key != null),
  );
  try {
    stmt.bind(opts.key != null ? [...namespaces, opts.key] : namespaces.slice());
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const namespace = String(row.namespace);
      const key = String(row.key);
      const id = reconcileId(namespace, key);
      const createdAt = row.created_at == null ? 0 : Number(row.created_at);
      // A row predating the updated_at backfill falls back to created_at: for a
      // DB row that IS the last-known edit time, unlike an artifact line where
      // substituting created_at would let a stale line win (see the reconcile
      // module's note on passing 0).
      const updatedAt = row.updated_at == null ? createdAt : Number(row.updated_at);
      const archived = String(row.status ?? 'active') === ARCHIVED_STATUS;

      records.set(
        id,
        archived
          ? { namespace, key, updatedAt, deletedAt: updatedAt }
          : { namespace, key, updatedAt, content: row.content == null ? '' : String(row.content) },
      );
      if (!withPayloads) continue;
      payloads.set(id, {
        id: String(row.id),
        namespace,
        key,
        content: row.content == null ? '' : String(row.content),
        type: row.type == null ? 'semantic' : String(row.type),
        tags: row.tags == null ? null : String(row.tags),
        metadata: row.metadata == null ? null : String(row.metadata),
        ownerId: row.owner_id == null ? null : String(row.owner_id),
        createdAt,
        updatedAt,
        embedding: row.embedding == null ? null : String(row.embedding),
        embeddingModel: row.embedding_model == null ? null : String(row.embedding_model),
        embeddingDimensions:
          row.embedding_dimensions == null ? null : Number(row.embedding_dimensions),
      });
    }
  } finally {
    try {
      stmt.free();
    } catch {
      /* best-effort cleanup */
    }
  }
  return { records, payloads };
}

/** What {@link applyDurableActions} actually wrote. Counts are rows affected, never inputs. */
export interface ApplyReport {
  inserted: number;
  updated: number;
  archived: number;
  resurrected: number;
  /** Actions whose payload the caller could not supply — a caller bug, counted not thrown. */
  skippedMissingPayload: number;
  /**
   * Inserts the UNIQUE(namespace, key) constraint swallowed. Non-zero means a
   * row exists that the snapshot cannot see — e.g. a pre-#728 `status='deleted'`
   * row surviving in an old consumer DB. Without this counter the plan would
   * re-attempt that insert every session with nothing to show for it.
   */
  skippedConflict: number;
}

const UPDATE_ROW_SQL =
  `UPDATE memory_entries SET content = ?, type = ?, tags = ?, metadata = ?, ` +
  `embedding = ?, embedding_model = ?, embedding_dimensions = ?, ` +
  `updated_at = ?, status = 'active' WHERE namespace = ? AND key = ?`;

const ARCHIVE_DURABLE_ROW_SQL =
  `UPDATE memory_entries SET status = '${ARCHIVED_STATUS}', updated_at = ?, ` +
  // The vector goes with the deletion: an archived row is excluded from index
  // builds anyway, and dropping it means a later resurrect cannot reuse a
  // vector that no longer matches whatever content wins.
  `embedding = NULL, embedding_model = NULL, embedding_dimensions = NULL ` +
  // `status = 'active'` guard: re-archiving an already-archived row would move
  // its deletion timestamp forward and could beat a legitimate re-creation on
  // the other side that had already won.
  `WHERE namespace = ? AND key = ? AND status = 'active'`;

/**
 * Apply a reconciliation plan to `db`. The whole batch runs in ONE transaction
 * — a half-applied merge would leave the store in a state no later run could
 * reason about, and a single commit is also one fsync instead of one per row on
 * the session-start hot path.
 *
 * `payloads` supplies the full row for every insert/update/resurrect action;
 * `delete` actions need only the timestamp the plan already carries.
 */
export function applyDurableActions(
  db: SqlJsLikeDatabase,
  actions: readonly ReconcileAction[],
  payloads: ReadonlyMap<string, DurablePayload>,
): ApplyReport {
  const report: ApplyReport = {
    inserted: 0,
    updated: 0,
    archived: 0,
    resurrected: 0,
    skippedMissingPayload: 0,
    skippedConflict: 0,
  };
  if (actions.length === 0) return report;

  db.run(MEMORY_SCHEMA_V3);

  let insertStmt: ReturnType<SqlJsLikeDatabase['prepare']> | null = null;
  let updateStmt: ReturnType<SqlJsLikeDatabase['prepare']> | null = null;
  let archiveStmt: ReturnType<SqlJsLikeDatabase['prepare']> | null = null;
  try {
    insertStmt = db.prepare(DURABLE_INSERT_OR_IGNORE_SQL);
    updateStmt = db.prepare(UPDATE_ROW_SQL);
    archiveStmt = db.prepare(ARCHIVE_DURABLE_ROW_SQL);

    db.run('BEGIN');
    try {
      for (const action of actions) {
        if (action.op === 'delete') {
          const { namespace, key } = action.record;
          archiveStmt.bind([action.record.deletedAt ?? Date.now(), namespace, key]);
          archiveStmt.step();
          if (db.getRowsModified() > 0) report.archived++;
          archiveStmt.reset();
          continue;
        }

        const payload = payloads.get(action.id);
        if (!payload) {
          report.skippedMissingPayload++;
          continue;
        }

        if (action.op === 'insert') {
          insertStmt.bind([
            payload.id,
            payload.key,
            payload.namespace,
            payload.content,
            payload.type,
            payload.embedding,
            payload.embeddingModel,
            payload.embeddingDimensions,
            payload.tags,
            payload.metadata,
            payload.ownerId,
            payload.createdAt,
            payload.updatedAt,
            'active',
          ]);
          insertStmt.step();
          if (db.getRowsModified() > 0) report.inserted++;
          else report.skippedConflict++;
          insertStmt.reset();
          continue;
        }

        // update | resurrect — the same write. They differ only in what the
        // target was before (a live row vs an archived one), which the plan has
        // already decided; `status = 'active'` covers both.
        updateStmt.bind([
          payload.content,
          payload.type,
          payload.tags,
          payload.metadata,
          payload.embedding,
          payload.embeddingModel,
          payload.embeddingDimensions,
          payload.updatedAt,
          payload.namespace,
          payload.key,
        ]);
        updateStmt.step();
        if (db.getRowsModified() > 0) {
          if (action.op === 'resurrect') report.resurrected++;
          else report.updated++;
        }
        updateStmt.reset();
      }
      db.run('COMMIT');
    } catch (e) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* best-effort — close() also discards an open transaction */
      }
      throw e;
    }
  } finally {
    for (const stmt of [insertStmt, updateStmt, archiveStmt]) {
      if (!stmt) continue;
      try {
        stmt.free();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  return report;
}

/**
 * Archive one durable row so the deletion can propagate, returning whether a
 * row was actually affected.
 *
 * The single archive implementation: both `flo memory delete` paths (offline
 * `entries-write.deleteEntry` and daemon `bridgeDeleteEntry`) call this rather
 * than binding the statement themselves, so the bind order and the
 * `status = 'active'` guard exist once. A hard delete in a durable namespace
 * would silently un-share nothing — the entry returns on the next import,
 * which is the #1463 failure mode in miniature.
 */
export function archiveDurableRow(
  db: SqlJsLikeDatabase,
  namespace: string,
  key: string,
  deletedAt: number,
): boolean {
  if (!hasMemoryEntriesTable(db)) return false;
  db.run(ARCHIVE_DURABLE_ROW_SQL, [deletedAt, namespace, key]);
  return db.getRowsModified() > 0;
}

/**
 * Drop archived durable rows whose deletion is older than `ttlMs`.
 *
 * Story #728 retired the previous soft-delete because tombstones were
 * write-only and grew without bound. Both halves of that are answered here: the
 * rows are read (by every sync direction, and by a re-creation that must beat
 * them), and this prune bounds them on the same 90-day window the artifact uses
 * — by which point every store has long since seen the deletion.
 *
 * Returns the number of rows removed.
 */
export function pruneExpiredArchives(
  db: SqlJsLikeDatabase,
  now: number,
  ttlMs: number,
  namespaces: readonly string[] = DURABLE_NAMESPACES,
): number {
  if (!hasMemoryEntriesTable(db)) return 0;
  // Probe before writing. `idx_memory_status` makes this a cheap index hit, and
  // most stores hold no archived rows at all — running the DELETE regardless
  // would open a write transaction on every session start for nothing.
  const probe = db.exec(
    `SELECT 1 FROM memory_entries WHERE status = '${ARCHIVED_STATUS}' AND updated_at < ? LIMIT 1`,
    [now - ttlMs],
  );
  if (!probe[0]?.values?.[0]) return 0;
  const placeholders = namespaces.map(() => '?').join(',');
  db.run(
    `DELETE FROM memory_entries WHERE status = '${ARCHIVED_STATUS}' ` +
      `AND namespace IN (${placeholders}) AND updated_at < ?`,
    [...namespaces, now - ttlMs],
  );
  return db.getRowsModified();
}
