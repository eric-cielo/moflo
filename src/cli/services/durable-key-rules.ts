/**
 * Rows that must never live in a durable namespace, whichever store they are in
 * (#1495).
 *
 * #1375 moved `verify:*` verdict records out of `learnings`, but only in the
 * local `.moflo/moflo.db`. The same rows still sat in the two durable copies —
 * the worktree shared store (`<git-common-dir>/moflo/durable.db`) and the team
 * JSONL artifact — and the session-start seed and import wrote them straight
 * back. The cleanup ran on every session and never converged, because each
 * store was healed by its own code path and none of the sync paths knew the
 * rule.
 *
 * This module is the ONE statement of the rule. The sync boundary applies it
 * (`readDurableSnapshot` never returns a misfiled row, so no flush, seed,
 * import or export can carry one), the shared store and artifact drop what they
 * already hold, and the local purge relocates or drops the local copy. A new
 * relocation rule is a new entry in {@link MISFILED_DURABLE_RULES} — never a
 * new clause in one store's cleanup, which is the shape that failed.
 *
 * Pure: no fs, no sqlite.
 *
 * @module cli/services/durable-key-rules
 */

import { VERIFY_RECORD_NAMESPACE } from '../memory/bridge-embedder.js';

/** The durable namespace user-authored lessons live in. */
export const LEARNINGS_NAMESPACE = 'learnings';

export interface MisfiledDurableRule {
  /** The durable namespace the row was wrongly written to. */
  namespace: string;
  /**
   * Case-sensitive key prefix. Matched with GLOB, not LIKE, in SQL — LIKE is
   * case-insensitive for ASCII and would sweep keys the writers never produced.
   * Must not contain GLOB metacharacters (`*`, `?`, `[`).
   */
  keyPrefix: string;
  /** Where the local purge re-files an active row. */
  relocateTo: string;
}

/** Every rule. `/verify` verdicts used to be written to `learnings` (#1375). */
export const MISFILED_DURABLE_RULES: readonly MisfiledDurableRule[] = [
  { namespace: LEARNINGS_NAMESPACE, keyPrefix: `${VERIFY_RECORD_NAMESPACE}:`, relocateTo: VERIFY_RECORD_NAMESPACE },
];

/** True when `(namespace, key)` is a row no durable store should hold. */
export function isMisfiledDurable(namespace: string, key: string): boolean {
  return MISFILED_DURABLE_RULES.some((r) => r.namespace === namespace && key.startsWith(r.keyPrefix));
}

export interface SqlPredicate {
  sql: string;
  params: string[];
}

/** SQL predicate matching the rows of ONE rule — the only place its shape is spelled. */
export function misfiledRuleSql(rule: MisfiledDurableRule): SqlPredicate {
  return { sql: '(namespace = ? AND key GLOB ?)', params: [rule.namespace, `${rule.keyPrefix}*`] };
}

/**
 * SQL predicate matching every misfiled row, with its bindings. Callers negate
 * it (`NOT (...)`) to read a clean durable slice, or use it as-is to delete.
 */
export function misfiledDurableSql(): SqlPredicate {
  if (MISFILED_DURABLE_RULES.length === 0) return { sql: '0', params: [] };
  const parts = MISFILED_DURABLE_RULES.map(misfiledRuleSql);
  return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
}

/**
 * Key shapes of a per-ticket run summary stored as a learning: `flo-2595-...`,
 * `2679-...`, or a `-done`/`-complete`/`-shipped`/`-merged` suffix.
 *
 * A heuristic on key shape only, which is why nothing moves on it
 * automatically: the session start COUNTS matches, and
 * `flo memory audit-learnings` nominates them for a verdict. Content is not
 * consulted — a real lesson can open with a ticket number as provenance
 * (`1145-daemon-port-collision-fix`), and that is exactly the case a model
 * verdict exists to tell apart.
 */
const TICKET_PREFIX = /^(?:flo-)?\d{3,5}-/;
const STATUS_SUFFIX = /-(?:done|complete|completed|shipped|merged)$/;
/** A date-prefixed key (`2026-09-28-...`) is a dated note, not a ticket number. */
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:\D|$)/;

/** True when a `learnings` key looks like a per-ticket run summary. */
export function isRunSummaryKey(key: string): boolean {
  if (STATUS_SUFFIX.test(key)) return true;
  return TICKET_PREFIX.test(key) && !DATE_PREFIX.test(key);
}
