/**
 * Idempotent session-start memory cleanup for moflo's memory DB
 * (`.moflo/moflo.db`).
 *
 * Two passes run in a single sql.js open:
 *
 * 1. **Hard-purge** namespaces in {@link PURGE_ON_SESSION_START_NAMESPACES} —
 *    `hive-mind`, `epic-state`, `test-bridge-fix`. These store internal
 *    run-tracking that does not need to survive a session restart. (#729)
 *
 * 2. **Relocate** `verify:*` rows out of `learnings` into
 *    {@link VERIFY_RECORD_NAMESPACE} (#1375). `/verify` used to write its
 *    per-run verdict to `learnings`, where the records became ~30% of the
 *    namespace and displaced real lessons in every bounded search. The skill
 *    now writes to `verify`, but that only stops the leak — this pass heals
 *    the backlog every consumer already carries, without waiting for a healer
 *    run. Rows are MOVED, not deleted: a verdict is a real audit record, just
 *    not a learning. The one exception is a key that already exists in
 *    `verify` (the newer verdict), where the stale copy is dropped and
 *    counted as `superseded`.
 *
 * 3. **Retention trim** `tasklist` and `verify` down to their row-count caps
 *    ({@link TASKLIST_RETENTION_CAP} / {@link VERIFY_RETENTION_CAP}).
 *    `tasklist` is the dashboard's "Flo Runs" tab data source
 *    (`daemon-dashboard.ts handleSpells`); the pre-#968 contract hard-purged
 *    it on every session start, leaving the tab permanently empty. Trim
 *    instead so users see recent history without unbounded growth.
 *
 * 4. **Strip vectors** from surviving rows in any ephemeral namespace
 *    ({@link ephemeralNamespaceSql} — `tasklist`, `swarm-*`, …). Their writers
 *    leave `embedding` NULL, but until #1492 the background backfill read that
 *    NULL as "pending" and embedded them, so run records ranked in ordinary
 *    `memory_search` results. The backfill no longer does; this heals the rows
 *    every existing install already carries, and re-heals if anything embeds
 *    them again. Rows are kept — only their vector is cleared, back to the
 *    shape the writer produced. The next index chain drops them from the HNSW
 *    sidecar (the DB write invalidates the `hnsw-rebuild` fingerprint).
 *
 * 5. **Count run summaries** (#1495) — active `learnings` rows whose key is
 *    shaped like a per-ticket run summary ({@link isRunSummaryKey}). Report
 *    only: key shape is a heuristic, so nothing moves on it here.
 *    `flo memory audit-learnings` nominates them for a verdict instead.
 *
 * The relocation in pass 2 is one of three halves of the #1495 heal: the
 * durable sync never reads a misfiled row (so the shared store and the team
 * artifact cannot seed it back), and each of those stores drops its own copy.
 * Healing this DB alone is what #1375 did, and the next seed undid it.
 *
 * All passes share the file open + final VACUUM + atomic write, so disk I/O
 * is the same as before. Writes back to disk only when something changed.
 *
 * Lives in `services/` so it has no dependency on the CLI command machinery.
 * That lets `bin/session-start-launcher.mjs` dynamic-import it and run in
 * foreground BEFORE long-lived sql.js consumers (MCP server, daemon) open
 * the DB — sql.js dumps the whole snapshot on every flush and would
 * otherwise clobber our cleanup (see #727's clobber-hazard analysis).
 *
 * @module cli/services/ephemeral-namespace-purge
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  ephemeralNamespaceSql,
  namespaceMatchSql,
  PURGE_ON_SESSION_START_NAMESPACES,
  PURGE_ON_SESSION_START_PREFIXES,
  TASKLIST_RETENTION_CAP,
  VERIFY_RECORD_NAMESPACE,
  VERIFY_RETENTION_CAP,
} from '../memory/bridge-embedder.js';
import { memoryDbPath } from './moflo-paths.js';
import {
  isRunSummaryKey,
  LEARNINGS_NAMESPACE,
  MISFILED_DURABLE_RULES,
  misfiledDurableSql,
  misfiledRuleSql,
} from './durable-key-rules.js';
import { readAuditState } from '../memory/learnings-audit-state.js';
import { openDaemonDatabase } from '../memory/daemon-backend.js';
import { resolveStateRoot } from './project-root.js';

export interface PurgeEphemeralNamespacesOptions {
  /** Path to the memory DB. Defaults to `<resolved project root>/.moflo/moflo.db` (#1315). */
  dbPath?: string;
  /**
   * Override the tasklist retention cap. Defaults to
   * {@link TASKLIST_RETENTION_CAP}. Tests use this to drive the trim path
   * without seeding hundreds of rows.
   */
  tasklistRetentionCap?: number;
  /**
   * Override the verify-record retention cap. Defaults to
   * {@link VERIFY_RETENTION_CAP}. Same testing purpose as
   * {@link PurgeEphemeralNamespacesOptions.tasklistRetentionCap}.
   */
  verifyRetentionCap?: number;
}

export interface PurgeEphemeralNamespacesResult {
  /** Number of rows hard-deleted from {@link PURGE_ON_SESSION_START_NAMESPACES}. */
  purged: number;
  /** Number of rows trimmed by the retention pass (`tasklist` + `verify`). */
  trimmed: number;
  /**
   * Number of `verify:*` rows moved out of `learnings` into
   * {@link VERIFY_RECORD_NAMESPACE} (#1375). Non-zero only on the first
   * session after upgrading — or if something writes a verdict to `learnings`
   * again, which is exactly what this pass exists to correct.
   */
  relocated: number;
  /**
   * Number of stray `learnings` rows DELETED rather than moved, because the
   * target namespace already held that key — the record there is the newer
   * verdict. Reported separately from {@link relocated} so the one destructive
   * step in this pass is never silently folded into a "moved N rows" count.
   */
  superseded: number;
  /**
   * Number of ephemeral-namespace rows whose embedding was cleared (#1492).
   * Non-zero on the first session after upgrading from a release whose
   * backfill embedded them.
   */
  stripped: number;
  /**
   * Active `learnings` rows whose key looks like a per-ticket run summary
   * (#1495). A count, not a write — see pass 5 in the module header.
   */
  runSummaries: number;
}

/**
 * Hard-delete rows in {@link PURGE_ON_SESSION_START_NAMESPACES}, relocate
 * stray `verify:*` records out of `learnings`, and trim the retention-capped
 * namespaces, then VACUUM. Returns all-zero counts on the happy path: no DB,
 * sql.js unavailable, schema lacks `memory_entries`, or nothing to clean.
 * Errors propagate to the caller (the launcher absorbs them so a failed purge
 * never blocks session start).
 */
export async function purgeEphemeralNamespaces(
  options: PurgeEphemeralNamespacesOptions = {},
): Promise<PurgeEphemeralNamespacesResult> {
  const fs = await import('fs');
  const path = await import('path');

  const nothingToDo: PurgeEphemeralNamespacesResult = {
    purged: 0, trimmed: 0, relocated: 0, superseded: 0, stripped: 0, runSummaries: 0,
  };

  const dbPath = path.resolve(options.dbPath ?? memoryDbPath(resolveStateRoot()));
  if (!fs.existsSync(dbPath)) return nothingToDo;

  // node:sqlite via the unified factory (Phase 5 / #1084). WAL persists each
  // DELETE/VACUUM incrementally; no atomicWriteFileSync needed.
  const db = openDaemonDatabase(dbPath);

  try {
    // Probe: schema must carry `memory_entries`. Older / non-moflo DBs are
    // a no-op so we don't VACUUM unrelated SQLite files.
    const probe = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) return nothingToDo;

    // Single COUNT pass to gate every write below — a clean DB is the steady
    // state and we don't want a handful of no-op DELETEs (with their
    // query-planner overhead) on every session start.
    //
    // Purge match shape: exact namespace IN (...) OR namespace LIKE 'prefix-%'.
    // The prefix clause covers runtime-suffixed namespaces like
    // `doctor-memprobe-<persona>` whose set of suffixes isn't known upfront.
    const caps: Array<[string, number]> = [
      ['tasklist', options.tasklistRetentionCap ?? TASKLIST_RETENTION_CAP],
      [VERIFY_RECORD_NAMESPACE, options.verifyRetentionCap ?? VERIFY_RETENTION_CAP],
    ];

    const { sql: purgeWhere, params: purgeBindings } = namespaceMatchSql(
      PURGE_ON_SESSION_START_NAMESPACES,
      PURGE_ON_SESSION_START_PREFIXES,
    );

    // The misfiled-row rule is shared with the durable sync (#1495), so this
    // pass and the stores it cannot reach agree on exactly which rows move.
    // GLOB, not LIKE: SQLite's LIKE is case-INSENSITIVE for ASCII, so
    // `key LIKE 'verify:%'` would also sweep a `Verify:...` row that
    // `gate.cjs`'s `record-verify-outcome` — which tests
    // `key.indexOf('verify:') !== 0` — would never have credited.
    const misfiled = misfiledDurableSql();

    const ephemeral = ephemeralNamespaceSql();
    const embeddedEphemeralWhere = `${ephemeral.sql} AND embedding IS NOT NULL`;

    // EVERY column needs a distinct alias. `exec` maps each row to an object
    // keyed by column name, so two columns that SQLite names identically
    // collapse into one and silently shift every later index. Unaliased
    // subqueries are named after their expression TEXT, which is identical for
    // each cap once the namespace is a bound `?` rather than a literal — the
    // trims then read a total that isn't theirs.
    const countRows = db.exec(
      `SELECT
         (SELECT COUNT(*) FROM memory_entries WHERE ${purgeWhere}) AS purgeable,
         (SELECT COUNT(*) FROM memory_entries WHERE ${misfiled.sql}) AS relocatable,
         (SELECT COUNT(*) FROM memory_entries WHERE ${embeddedEphemeralWhere}) AS strippable,
         ${caps.map((_, i) => `(SELECT COUNT(*) FROM memory_entries WHERE namespace = ?) AS capTotal${i}`).join(',\n         ')}`,
      [...purgeBindings, ...misfiled.params, ...ephemeral.params, ...caps.map(([ns]) => ns)],
    );
    const counts = countRows[0]?.values?.[0] ?? [];
    const purgeable = Number(counts[0] ?? 0);
    const relocatable = Number(counts[1] ?? 0);
    const strippable = Number(counts[2] ?? 0);
    const capTotals = caps.map((_, i) => Number(counts[i + 3] ?? 0));

    let purged = 0;
    if (purgeable > 0) {
      db.run(
        `DELETE FROM memory_entries WHERE ${purgeWhere}`,
        purgeBindings,
      );
      purged = db.getRowsModified?.() ?? 0;
    }

    let relocated = 0;
    let superseded = 0;
    let relocatedIntoVerify = 0;
    for (const rule of relocatable > 0 ? MISFILED_DURABLE_RULES : []) {
      const { sql: ruleWhere, params: ruleBindings } = misfiledRuleSql(rule);
      // UNIQUE(namespace, key): a stray row whose key already exists in the
      // target cannot simply move — the UPDATE would violate the constraint,
      // and `UPDATE OR REPLACE` would clobber the newer record with the older.
      // Drop the stray copy instead, and COUNT it: this is the one place the
      // pass destroys a row rather than re-filing it, so it must surface in the
      // result rather than hide inside `relocated`.
      db.run(
        `DELETE FROM memory_entries
          WHERE ${ruleWhere}
            AND key IN (SELECT key FROM memory_entries WHERE namespace = ?)`,
        [...ruleBindings, rule.relocateTo],
      );
      superseded += db.getRowsModified?.() ?? 0;
      // Content is unchanged, so the row's existing embedding stays valid: the
      // HNSW sidecar is keyed by row id and re-reads `namespace` from SQL on
      // every index build, so this is a re-filing, not a re-index.
      db.run(
        `UPDATE memory_entries SET namespace = ? WHERE ${ruleWhere}`,
        [rule.relocateTo, ...ruleBindings],
      );
      const moved = db.getRowsModified?.() ?? 0;
      relocated += moved;
      if (rule.relocateTo === VERIFY_RECORD_NAMESPACE) relocatedIntoVerify += moved;
    }

    // After the purge, so rows it already deleted are not counted twice. Model
    // goes back to NULL — the exact shape the ephemeral writers produce.
    let stripped = 0;
    if (strippable > 0) {
      db.run(
        `UPDATE memory_entries
            SET embedding = NULL, embedding_model = NULL, embedding_dimensions = NULL
          WHERE ${embeddedEphemeralWhere}`,
        ephemeral.params,
      );
      stripped = db.getRowsModified?.() ?? 0;
    }

    let trimmed = 0;
    for (const [i, [ns, cap]] of caps.entries()) {
      // Rows just relocated into `verify` count toward its cap in this same run.
      const total = capTotals[i] + (ns === VERIFY_RECORD_NAMESPACE ? relocatedIntoVerify : 0);
      if (total <= cap) continue;
      // Keep the newest `cap` rows by created_at, falling back to `id DESC`
      // for legacy rows that predate the created_at-not-null schema (#728-era).
      db.run(
        `DELETE FROM memory_entries
         WHERE namespace = ?
           AND id NOT IN (
             SELECT id FROM memory_entries
             WHERE namespace = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )`,
        [ns, ns, cap],
      );
      trimmed += db.getRowsModified?.() ?? 0;
    }

    // The DB is `<root>/.moflo/moflo.db`; the audit's verdict record sits beside it.
    const runSummaries = countRunSummaries(db, path.dirname(path.dirname(dbPath)));

    if (purged === 0 && trimmed === 0 && relocated === 0 && superseded === 0 && stripped === 0) {
      return { ...nothingToDo, runSummaries };
    }

    // VACUUM only after a DELETE actually freed pages. A relocation is an
    // UPDATE that reclaims nothing; a vector strip frees some pages, but later
    // writes reuse them. VACUUMing for either would rewrite the whole file
    // (60+ MB on a populated store) in the foreground of session start for no
    // real benefit. Has to run outside any open transaction; node:sqlite/sql.js
    // both auto-commit each `db.run`, so this is safe to chain.
    if (purged > 0 || trimmed > 0 || superseded > 0) db.run('VACUUM');

    return { purged, trimmed, relocated, superseded, stripped, runSummaries };
  } finally {
    db.close();
  }
}

/**
 * Count active `learnings` rows keyed like a per-ticket run summary. Keys only
 * — a single indexed read of short strings, cheap on a store of thousands.
 *
 * Keys `flo memory audit-learnings` already judged are skipped: a KEEP is a
 * human saying "this one is a lesson", and a notice that ignored it would print
 * on every session forever.
 */
function countRunSummaries(db: ReturnType<typeof openDaemonDatabase>, projectRoot: string): number {
  const rows = db.exec(
    `SELECT key FROM memory_entries WHERE namespace = ? AND status = 'active'`,
    [LEARNINGS_NAMESPACE],
  );
  let decided: ReadonlyMap<string, unknown> | null = null;
  let count = 0;
  for (const [raw] of rows[0]?.values ?? []) {
    const key = String(raw);
    if (!isRunSummaryKey(key)) continue;
    decided ??= readAuditState(projectRoot);
    if (!decided.has(key)) count++;
  }
  return count;
}

export interface PurgeMemoryProbeNamespacesOptions {
  /** Path to the memory DB. Defaults to `<resolved project root>/.moflo/moflo.db` (#1315). */
  dbPath?: string;
}

/**
 * Hard-delete rows whose namespace matches one of
 * {@link PURGE_ON_SESSION_START_PREFIXES} — currently `doctor-memprobe-*`
 * and `doctor-neighbors-*`. Scoped down from {@link purgeEphemeralNamespaces}:
 * no exact-namespace pass, no tasklist trim, no VACUUM. Returns
 * `{ purged: 0 }` on a missing DB / missing `memory_entries` / clean state.
 *
 * Intended for the doctor's Memory Access functional check finally block
 * (#1166). Only the doctor writes to these namespaces in production, so
 * sweeping by prefix at the end of every healer run kills the
 * `populated:ephemeral-purged` flake class — a per-key `safeDelete` that
 * silently no-ops (row not visible at delete time, MCP transport error,
 * `memory_delete` returning `success: true, deleted: false`) no longer
 * leaks a row into the next assertion. The launcher's session-start
 * purge stays in place as a defence-in-depth safety net for residue from
 * crashed-process scenarios where the doctor never reached its finally.
 *
 * Errors propagate to the caller (the doctor absorbs them so a failed
 * sweep never poisons the check return value).
 */
export async function purgeMemoryProbeNamespaces(
  options: PurgeMemoryProbeNamespacesOptions = {},
): Promise<{ purged: number }> {
  const fs = await import('fs');
  const path = await import('path');

  const dbPath = path.resolve(options.dbPath ?? memoryDbPath(resolveStateRoot()));
  if (!fs.existsSync(dbPath)) return { purged: 0 };

  const prefixes = Array.from(PURGE_ON_SESSION_START_PREFIXES);
  if (prefixes.length === 0) return { purged: 0 };

  const db = openDaemonDatabase(dbPath);
  try {
    const probe = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`,
    );
    if (!probe[0]?.values?.[0]) return { purged: 0 };

    const whereClause = prefixes.map(() => 'namespace LIKE ?').join(' OR ');
    const bindings = prefixes.map((p) => `${p}%`);

    const countRows = db.exec(
      `SELECT COUNT(*) FROM memory_entries WHERE ${whereClause}`,
      bindings,
    );
    const purgeable = Number(countRows[0]?.values?.[0]?.[0] ?? 0);
    if (purgeable === 0) return { purged: 0 };

    db.run(`DELETE FROM memory_entries WHERE ${whereClause}`, bindings);
    return { purged: db.getRowsModified?.() ?? 0 };
  } finally {
    db.close();
  }
}
