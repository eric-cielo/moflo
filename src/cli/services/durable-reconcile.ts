/**
 * The durable-learning reconciliation plan (#1463).
 *
 * Before this module, every path that synced durable learnings between two
 * stores was additive on keys: team export skipped any key already in the
 * artifact, team import ran `INSERT OR IGNORE`, and the worktree durable sync
 * ran both directions through the same ignore-on-conflict copy. A correction
 * and a deletion were dropped in every direction, so a purge could not be made
 * to stick — the entry came back at the next session-start import.
 *
 * That was three independent copies of the same defect. This module is the ONE
 * implementation of the merge rule; the four call sites differ only in how they
 * read records out of their store and how they apply the resulting actions.
 * Adding a fifth sync path means reading records into {@link ReconcileRecord}
 * and applying {@link ReconcileAction} — never re-deriving the rule.
 *
 * The module is deliberately pure: no fs, no sqlite, no clock. Everything it
 * decides is a function of the two maps handed to it, which is what makes the
 * conflict matrix directly testable in both orderings.
 *
 * ## The rule
 *
 * A record is either **live** (has `content`) or a **tombstone** (has
 * `deletedAt`). For each key present in the SOURCE:
 *
 * | source | target | outcome |
 * |---|---|---|
 * | live | absent | `insert` |
 * | live | live, same content | unchanged |
 * | live | live, source newer | `update` |
 * | live | live, target newer | kept (target wins) |
 * | live | tombstone, source newer | `resurrect` |
 * | live | tombstone, tombstone newer | kept (the purge stands) |
 * | tombstone | absent | nothing — never shared, nothing to delete |
 * | tombstone | live, tombstone newer | `delete` |
 * | tombstone | live, target newer | kept (re-created after the purge) |
 * | tombstone | tombstone | unchanged |
 *
 * And the rule that matters most, covering every key present in the TARGET but
 * absent from the source: **leave it alone.** The naive alternative — delete
 * anything the source lacks — cannot tell a remote deletion from local work
 * that was never exported, and would destroy the latter. Only an explicit
 * tombstone ever deletes.
 *
 * Comparisons are strict: equal timestamps produce no action. A tie means two
 * stores disagree with no evidence about which is later, and the safe reading
 * of "no evidence" is "change nothing".
 *
 * @module cli/services/durable-reconcile
 */

/** Separator for the composite (namespace, key) identity. NUL can't occur in either. */
const ID_SEP = String.fromCharCode(0);

/**
 * Composite identity for a durable row. Namespaces share keys — the
 * `knowledge` → `learnings` migration guarantees overlap — so a key alone is
 * not an identity and never was.
 */
export function reconcileId(namespace: string, key: string): string {
  return `${namespace}${ID_SEP}${key}`;
}

/** Split a {@link reconcileId} back into its parts. */
export function splitReconcileId(id: string): { namespace: string; key: string } {
  const at = id.indexOf(ID_SEP);
  return at < 0
    ? { namespace: '', key: id }
    : { namespace: id.slice(0, at), key: id.slice(at + 1) };
}

/**
 * One record as the merge rule sees it — the minimum needed to decide. Callers
 * keep their own richer row/line objects keyed by the same {@link reconcileId}
 * and look them up when applying, so nothing store-specific leaks in here.
 */
export interface ReconcileRecord {
  namespace: string;
  key: string;
  /**
   * Epoch-ms of the last edit. A store that cannot supply one (a pre-#1463
   * artifact line) MUST pass 0 rather than substituting `created_at`: 0 loses
   * every comparison, which preserves the old append-only behaviour for those
   * lines instead of letting a stale line overwrite a corrected local row.
   */
  updatedAt: number;
  /** Epoch-ms of the deletion. Present iff this record is a tombstone. */
  deletedAt?: number;
  /** The comparable payload. Absent on tombstones. */
  content?: string;
}

/** True when a record represents a deletion rather than a live entry. */
export function isTombstone(record: ReconcileRecord): boolean {
  return typeof record.deletedAt === 'number';
}

/**
 * The instant a record last changed, whichever kind it is. Used for every
 * cross-kind comparison (live vs tombstone) so the matrix stays one rule —
 * exported because callers settling duplicates within one store need the same
 * basis, and a second copy of it is a second policy waiting to diverge.
 */
export function recordStamp(record: ReconcileRecord): number {
  return isTombstone(record) ? (record.deletedAt as number) : record.updatedAt;
}

export type ReconcileOp =
  /** Key absent from the target — add it. */
  | 'insert'
  /** Live in both, source newer and different — overwrite the target. */
  | 'update'
  /** Source tombstone beats a live target — tombstone/archive the target. */
  | 'delete'
  /** Live source beats a target tombstone — the entry was re-created. */
  | 'resurrect';

export interface ReconcileAction {
  id: string;
  op: ReconcileOp;
  /** The SOURCE record the action carries. Applying means making the target match it. */
  record: ReconcileRecord;
}

/** Per-run tallies. Every source key lands in exactly one of these, plus `targetOnly`. */
export interface ReconcileSummary {
  inserted: number;
  updated: number;
  deleted: number;
  resurrected: number;
  /** Present in both and already in agreement. */
  unchanged: number;
  /** Source had a change, but the target's version is newer and wins. */
  keptTargetNewer: number;
  /** Keys only the target has. Never touched — see the module header. */
  targetOnly: number;
}

export interface ReconcilePlan {
  actions: ReconcileAction[];
  summary: ReconcileSummary;
}

/** True when the plan would change nothing. Callers use it to skip a write. */
export function isNoOpPlan(plan: ReconcilePlan): boolean {
  return plan.actions.length === 0;
}

/**
 * Compute what the target must do to match the source. Pure — the caller
 * applies the actions and owns every side effect.
 *
 * Direction is entirely the caller's: pass (DB, artifact) to export and
 * (artifact, DB) to import. The rule is symmetric, which is the point.
 */
export function planReconcile(
  source: ReadonlyMap<string, ReconcileRecord>,
  target: ReadonlyMap<string, ReconcileRecord>,
): ReconcilePlan {
  const actions: ReconcileAction[] = [];
  const summary: ReconcileSummary = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    resurrected: 0,
    unchanged: 0,
    keptTargetNewer: 0,
    targetOnly: 0,
  };

  for (const [id, src] of source) {
    const dst = target.get(id);

    if (!dst) {
      // A tombstone for a key the target never had is not a deletion to
      // propagate — the entry was never shared there. Dropping it here is also
      // what keeps a tombstone from resurrecting as a row on a fresh install.
      if (isTombstone(src)) {
        summary.unchanged++;
        continue;
      }
      actions.push({ id, op: 'insert', record: src });
      summary.inserted++;
      continue;
    }

    const srcDead = isTombstone(src);
    const dstDead = isTombstone(dst);

    if (srcDead && dstDead) {
      // Both sides already agree the entry is gone. Refreshing the target's
      // timestamp would churn the artifact diff for no semantic gain.
      summary.unchanged++;
      continue;
    }

    if (!srcDead && !dstDead && src.content === dst.content) {
      summary.unchanged++;
      continue;
    }

    // Strict: a tie changes nothing. See the module header.
    if (recordStamp(src) <= recordStamp(dst)) {
      summary.keptTargetNewer++;
      continue;
    }

    const op: ReconcileOp = srcDead ? 'delete' : dstDead ? 'resurrect' : 'update';
    actions.push({ id, op, record: src });
    if (op === 'delete') summary.deleted++;
    else if (op === 'resurrect') summary.resurrected++;
    else summary.updated++;
  }

  for (const id of target.keys()) {
    if (!source.has(id)) summary.targetOnly++;
  }

  return { actions, summary };
}

/** Default age past which a tombstone is dropped from an artifact on export. */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * True when a tombstone is old enough to drop. Every store that was going to
 * see the deletion has seen it long before 90 days, and keeping them forever
 * would grow the artifact without bound.
 *
 * Live records are never prunable — the caller passes the whole map through.
 */
export function isPrunableTombstone(
  record: ReconcileRecord,
  now: number,
  ttlMs: number = TOMBSTONE_TTL_MS,
): boolean {
  return isTombstone(record) && now - (record.deletedAt as number) > ttlMs;
}
