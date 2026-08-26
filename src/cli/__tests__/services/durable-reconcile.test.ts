/**
 * Tests for the shared durable-learning reconciliation plan (#1463).
 *
 * The conflict matrix is the whole point of the module, so every row of it is
 * driven in BOTH orderings — a test that only exercises the ordering that
 * happens to pass would not have caught the additive bug this replaces.
 *
 * Pure module: no fs, no sqlite, no clock.
 */
import { describe, it, expect } from 'vitest';

import {
  planReconcile,
  reconcileId,
  splitReconcileId,
  isTombstone,
  isNoOpPlan,
  isPrunableTombstone,
  TOMBSTONE_TTL_MS,
  type ReconcileRecord,
} from '../../services/durable-reconcile.js';

const live = (key: string, content: string, updatedAt: number, namespace = 'learnings'): ReconcileRecord =>
  ({ namespace, key, content, updatedAt });

const dead = (key: string, deletedAt: number, namespace = 'learnings'): ReconcileRecord =>
  ({ namespace, key, updatedAt: 0, deletedAt });

const mapOf = (...records: ReconcileRecord[]): Map<string, ReconcileRecord> =>
  new Map(records.map((r) => [reconcileId(r.namespace, r.key), r]));

const opFor = (source: Map<string, ReconcileRecord>, target: Map<string, ReconcileRecord>): string => {
  const plan = planReconcile(source, target);
  return plan.actions.length === 0 ? 'none' : plan.actions[0].op;
};

describe('reconcileId', () => {
  it('separates namespace from key so the two durable namespaces cannot collide', () => {
    expect(reconcileId('learnings', 'x')).not.toBe(reconcileId('knowledge', 'x'));
  });

  it('round-trips through splitReconcileId, including keys containing separators', () => {
    for (const key of ['plain', 'with:colon', 'with/slash', 'with\tnewline-ish']) {
      expect(splitReconcileId(reconcileId('learnings', key))).toEqual({ namespace: 'learnings', key });
    }
  });
});

describe('planReconcile — the conflict matrix', () => {
  it('inserts a key the target lacks', () => {
    expect(opFor(mapOf(live('a', 'v1', 100)), new Map())).toBe('insert');
  });

  it('leaves a matching entry alone', () => {
    const plan = planReconcile(mapOf(live('a', 'v1', 200)), mapOf(live('a', 'v1', 100)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.unchanged).toBe(1);
  });

  // The correction case — the one the additive implementations could never do.
  it('updates when the source is newer and the content differs', () => {
    expect(opFor(mapOf(live('a', 'corrected', 200)), mapOf(live('a', 'stale', 100)))).toBe('update');
  });

  it('keeps the target when the target is newer — the same pair, reversed', () => {
    const plan = planReconcile(mapOf(live('a', 'stale', 100)), mapOf(live('a', 'corrected', 200)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.keptTargetNewer).toBe(1);
  });

  it('deletes a live target when the source tombstone is newer', () => {
    expect(opFor(mapOf(dead('a', 200)), mapOf(live('a', 'v1', 100)))).toBe('delete');
  });

  it('does NOT delete an entry re-created after the purge — the same pair, reversed', () => {
    const plan = planReconcile(mapOf(dead('a', 100)), mapOf(live('a', 'recreated', 200)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.keptTargetNewer).toBe(1);
  });

  it('resurrects when a live source is newer than a target tombstone', () => {
    expect(opFor(mapOf(live('a', 'recreated', 200)), mapOf(dead('a', 100)))).toBe('resurrect');
  });

  it('lets the purge stand when the tombstone is newer — the same pair, reversed', () => {
    expect(opFor(mapOf(live('a', 'v1', 100)), mapOf(dead('a', 200)))).toBe('none');
  });

  it('does nothing for a tombstone the target never had', () => {
    const plan = planReconcile(mapOf(dead('gone', 500)), new Map());
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.inserted).toBe(0);
  });

  it('treats two tombstones as settled', () => {
    const plan = planReconcile(mapOf(dead('a', 200)), mapOf(dead('a', 100)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.unchanged).toBe(1);
  });
});

describe('planReconcile — local-only work is never touched', () => {
  // The regression that matters most: "delete anything the source lacks" would
  // destroy work authored here and not yet exported.
  it('leaves a target-only key alone with no tombstones in play', () => {
    const plan = planReconcile(mapOf(live('shared', 'v1', 100)), mapOf(live('shared', 'v1', 100), live('mine', 'local', 100)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.targetOnly).toBe(1);
  });

  it('leaves a target-only key alone even when the source carries tombstones for other keys', () => {
    const plan = planReconcile(mapOf(dead('purged', 500)), mapOf(live('mine', 'local', 100)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.targetOnly).toBe(1);
  });
});

describe('planReconcile — ties', () => {
  it('changes nothing when two live records share a timestamp', () => {
    expect(opFor(mapOf(live('a', 'theirs', 100)), mapOf(live('a', 'ours', 100)))).toBe('none');
  });

  it('changes nothing when a tombstone ties with a live record', () => {
    expect(opFor(mapOf(dead('a', 100)), mapOf(live('a', 'ours', 100)))).toBe('none');
  });
});

describe('planReconcile — a record with no usable timestamp', () => {
  // A pre-#1463 artifact line has no updated_at; callers pass 0. It must still
  // seed a store that lacks the key, and must never overwrite one that has it.
  it('still inserts where the target lacks the key', () => {
    expect(opFor(mapOf(live('a', 'legacy', 0)), new Map())).toBe('insert');
  });

  it('never overwrites an existing target row', () => {
    const plan = planReconcile(mapOf(live('a', 'legacy', 0)), mapOf(live('a', 'corrected locally', 1)));
    expect(plan.actions).toHaveLength(0);
    expect(plan.summary.keptTargetNewer).toBe(1);
  });
});

describe('planReconcile — summary', () => {
  it('accounts for every source key exactly once, plus target-only keys', () => {
    const source = mapOf(
      live('ins', 'new', 100),
      live('upd', 'newer', 200),
      live('same', 'v1', 100),
      live('older', 'stale', 50),
      dead('del', 300),
    );
    const target = mapOf(
      live('upd', 'older', 100),
      live('same', 'v1', 100),
      live('older', 'fresher', 100),
      live('del', 'doomed', 100),
      live('theirs', 'untouched', 100),
    );
    const { summary, actions } = planReconcile(source, target);

    expect(summary.inserted).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.keptTargetNewer).toBe(1);
    expect(summary.targetOnly).toBe(1);

    const accountedSourceKeys =
      summary.inserted + summary.updated + summary.deleted + summary.resurrected +
      summary.unchanged + summary.keptTargetNewer;
    expect(accountedSourceKeys).toBe(source.size);
    expect(actions).toHaveLength(3);
  });

  it('reports a no-op plan for two identical stores', () => {
    const both = () => mapOf(live('a', 'v1', 100), live('b', 'v2', 200));
    expect(isNoOpPlan(planReconcile(both(), both()))).toBe(true);
  });
});

describe('isTombstone / isPrunableTombstone', () => {
  it('classifies by deletedAt, not by empty content', () => {
    expect(isTombstone(dead('a', 1))).toBe(true);
    expect(isTombstone(live('a', '', 1))).toBe(false);
  });

  it('prunes a tombstone past the TTL and keeps one inside it', () => {
    const now = 10 * TOMBSTONE_TTL_MS;
    expect(isPrunableTombstone(dead('a', now - TOMBSTONE_TTL_MS - 1), now)).toBe(true);
    expect(isPrunableTombstone(dead('a', now - TOMBSTONE_TTL_MS + 1), now)).toBe(false);
  });

  it('never prunes a live record however old', () => {
    expect(isPrunableTombstone(live('a', 'ancient', 0), 10 * TOMBSTONE_TTL_MS)).toBe(false);
  });
});
