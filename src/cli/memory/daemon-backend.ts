/**
 * Daemon-side memory DB factory — TS twin of `bin/lib/get-backend.mjs`.
 *
 * Returns a handle whose surface matches the sql.js `Database` type that the
 * controller registry + bridge code expect (prepare → Statement, run, exec,
 * close, plus a `save()` that maps to the engine's preferred persistence).
 * Currently always returns a node:sqlite-backed adapter — Phase 4 (#1083)
 * flipped the SQLite default; Phase 5 (#1084) deletes the remaining sql.js
 * paths in the bridge + memory-initializer.
 *
 * The sql.js Statement API the bridge code relies on:
 *   - db.prepare(sql) → stmt
 *   - db.run(sql, params?)
 *   - db.exec(sql) → [{ columns, values }]
 *   - db.close()
 *   - stmt.bind(params)
 *   - stmt.step() → boolean
 *   - stmt.getAsObject() → row object
 *   - stmt.run(params?) → boolean
 *   - stmt.free()
 *
 * node:sqlite's `StatementSync` is stateless (each call takes params), so we
 * shim a stateful wrapper via `stmt.iterate(...)` opened on first `step()`.
 * This is the same shape implemented in bin/lib/get-backend.mjs — keep the
 * two in lockstep until Phase 5 collapses them.
 *
 * @module v3/memory/daemon-backend
 */

// MUST come before `import 'node:sqlite'` below — that module fires
// `ExperimentalWarning: SQLite is an experimental feature` exactly once per
// process on first load. Once it fires, there's no way to scrub it from
// stderr, and consumer-smoke's 200-char stderr tails get filled with it
// (hiding the real error message; #1098).
import './suppress-sqlite-warning.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';

/**
 * Shape-compatible with both sql.js's `Statement` and the
 * `SqlJsStatement` interface in `./controllers/types.ts`. Matching the
 * structural intersection of those is what lets controllers consume this
 * handle without any per-controller change.
 */
interface SqlJsLikeStatement {
  bind(params?: unknown): boolean;
  step(): boolean;
  getAsObject(params?: unknown): Record<string, unknown>;
  get(params?: unknown): unknown[];
  getColumnNames(): string[];
  run(params?: unknown): boolean;
  reset(): void;
  free(): void;
}

export interface SqlJsLikeDatabase {
  /** Engine identifier — controllers can branch on this if absolutely needed. */
  readonly kind: 'node-sqlite';
  /** Underlying node:sqlite handle (escape hatch for code that needs engine-specific calls). */
  readonly _raw: DatabaseSync;
  prepare(sql: string): SqlJsLikeStatement;
  run(sql: string, params?: unknown): unknown;
  /**
   * sql.js parity: returns rows as `[{ columns, values }]`. Bridge readers
   * (bridge-core.execRows, bridge-entries) pass a positional params array as
   * the second argument; node:sqlite needs the params spread into
   * `stmt.all(...params)`.
   */
  exec(sql: string, params?: unknown): Array<{ columns: string[]; values: unknown[][] }>;
  getRowsModified(): number;
  /** sql.js parity: writeFileSync of the db buffer. node:sqlite WAL persists incrementally — no-op. */
  save(): void;
  /** sql.js parity: export the whole DB as a buffer. node:sqlite uses `db.serialize()`. */
  export(): Uint8Array;
  close(): void;
}

/**
 * Coerce a caller-supplied parameter set into node:sqlite's `SQLInputValue[]`
 * shape. Callers pass `any` (sql.js parity) so we just pass through after
 * normalising null/undefined/array.
 */
function toParamsArray(params: unknown): SQLInputValue[] {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params as SQLInputValue[];
  // sql.js's `Statement.bind(obj)` named-param shape isn't reachable from
  // moflo's bridge code today — every caller passes an array. Tolerate
  // anyway by wrapping the lone value.
  return [params as SQLInputValue];
}

function wrapStatement(stmt: StatementSync): SqlJsLikeStatement {
  let pendingParams: SQLInputValue[] = [];
  let iter: IterableIterator<unknown> | null = null;
  let currentRow: Record<string, unknown> | null = null;
  let columnNamesCache: string[] | null = null;

  const ensureIter = (): void => {
    if (!iter) {
      iter = (pendingParams.length > 0
        ? stmt.iterate(...pendingParams)
        : stmt.iterate()) as IterableIterator<unknown>;
    }
  };

  return {
    bind(params?: unknown): boolean {
      pendingParams = toParamsArray(params);
      iter = null;
      currentRow = null;
      return true;
    },
    step(): boolean {
      ensureIter();
      const next = iter!.next();
      if (next.done) {
        currentRow = null;
        return false;
      }
      currentRow = next.value as Record<string, unknown>;
      return true;
    },
    getAsObject(params?: unknown): Record<string, unknown> {
      // sql.js semantics: with params it's a one-shot bind+step+return;
      // without params it returns whatever the last step() materialised. The
      // bridge uses both shapes (one-shot in bridge-entries.ts:bridgeGetEntry,
      // iterator in list/search). Returning {} from the one-shot form when
      // there's no row is correct (caller checks for nullish primary key).
      if (params !== undefined) {
        pendingParams = toParamsArray(params);
        iter = null;
        ensureIter();
        const next = iter!.next();
        if (next.done) {
          currentRow = null;
          return {};
        }
        currentRow = next.value as Record<string, unknown>;
        return currentRow;
      }
      return currentRow ?? {};
    },
    get(params?: unknown): unknown[] {
      // sql.js `Statement.get()` semantics:
      //   - With params: one-shot bind+step, returns positional values of the
      //     first row (or [] if no rows).
      //   - Without params: returns positional values of the CURRENT row —
      //     the row that the most-recent `step()` landed on. Callers use it
      //     in a `while (stmt.step()) { const row = stmt.get(); ... }` loop;
      //     calling iter.next() again here would skip every other row.
      if (params !== undefined) {
        pendingParams = toParamsArray(params);
        iter = null;
        ensureIter();
        const next = iter!.next();
        if (next.done) {
          currentRow = null;
          return [];
        }
        currentRow = next.value as Record<string, unknown>;
      }
      if (!currentRow) return [];
      const cols = columnNamesCache ?? Object.keys(currentRow);
      columnNamesCache = cols;
      return cols.map((c) => currentRow![c]);
    },
    getColumnNames(): string[] {
      if (columnNamesCache) return columnNamesCache;
      // Force one step to materialise a row so column names are knowable.
      ensureIter();
      const next = iter!.next();
      if (next.done) {
        columnNamesCache = [];
        currentRow = null;
        return [];
      }
      currentRow = next.value as Record<string, unknown>;
      columnNamesCache = Object.keys(currentRow);
      return columnNamesCache;
    },
    run(params?: unknown): boolean {
      const arr = toParamsArray(params);
      if (arr.length > 0) stmt.run(...arr);
      else stmt.run();
      return true;
    },
    reset(): void {
      iter = null;
      currentRow = null;
    },
    free(): void {
      iter = null;
      currentRow = null;
      pendingParams = [];
      columnNamesCache = null;
    },
  };
}

/**
 * Per-process dedupe of network-FS warnings — emit once per (dbPath, process).
 * Matches the JS twin's `_networkFsWarnedPaths` set so a session that opens
 * both the daemon adapter and a bin/ writer on the same path only logs once.
 */
const _networkFsWarnedPaths = new Set<string>();

/**
 * Shared parking buffer for the journal-mode retry sleep. `Atomics.wait` is
 * the only synchronous sleep that works identically on Linux, macOS and
 * Windows without shelling out (Rule #1) — and this open path is synchronous,
 * so there is no `await` to hand the thread back with.
 */
const WAL_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms: number): void {
  Atomics.wait(WAL_SLEEP_BUF, 0, 0, ms);
}

/**
 * The open-path `busy_timeout`. Named because two places depend on it being
 * the same number: the pragma below sets it, and `readJournalModeBounded`
 * restores it after narrowing it for a probe.
 */
const OPEN_BUSY_TIMEOUT_MS = 15_000;
/**
 * Budget for the post-exhaustion probe. The query form of `PRAGMA
 * journal_mode` takes a SHARED lock and IS covered by the busy handler, so it
 * would otherwise inherit the full `OPEN_BUSY_TIMEOUT_MS` — doubling the
 * worst case to ~30s before we report anything on the one path where we have
 * already decided to give up. A few short attempts distinguish "genuinely not
 * WAL" from "probe lost one more race" without reopening that window.
 */
const WAL_PROBE_BUSY_TIMEOUT_MS = 500;
const WAL_PROBE_ATTEMPTS = 3;
/**
 * Total time `setWalWithRetry` will spend losing the conversion race before it
 * gives up. Matched to `busy_timeout` (15000ms) on purpose: the two cover the
 * same worst case — a background indexer holding a write lock through its
 * whole first full-tree pass — and diverging budgets would mean the pragma
 * that needs the wait most gets the shortest one. Being wrong-high costs one
 * slow open in a rare race; being wrong-low kills the process outright.
 */
const WAL_RETRY_BUDGET_MS = OPEN_BUSY_TIMEOUT_MS;
/** Backoff bounds: start tight (most races clear in a few ms), cap so a long
 *  hold is still polled often enough to return promptly once it releases. */
const WAL_RETRY_MIN_DELAY_MS = 5;
const WAL_RETRY_MAX_DELAY_MS = 250;

/** The pragma target, duck-typed so tests can drive the retry with a fake. */
interface WalPragmaTarget {
  exec(sql: string): unknown;
  prepare(sql: string): { get(): unknown };
}

/**
 * SQLITE_BUSY (5) and SQLITE_LOCKED (6) — the two contention codes. The
 * message test is a fallback for wrappers that don't propagate `errcode`.
 */
function isBusyError(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  if (e?.errcode === 5 || e?.errcode === 6) return true;
  return /database( table)? is locked/i.test(String(e?.message ?? ''));
}

/** Current journal mode, lowercased. `''` when the probe itself fails. */
function readJournalMode(db: WalPragmaTarget): string {
  try {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    return String(row?.journal_mode ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * `readJournalMode` under a deliberately narrow busy budget, restoring the
 * open-path budget afterwards so a caller that survives keeps the connection
 * it asked for. Only ever called once the retry budget is already spent.
 */
function readJournalModeBounded(db: WalPragmaTarget): string {
  try {
    try {
      db.exec(`PRAGMA busy_timeout = ${WAL_PROBE_BUSY_TIMEOUT_MS}`);
    } catch {
      // Non-fatal: we still probe, just without the narrower budget.
    }
    for (let attempt = 0; attempt < WAL_PROBE_ATTEMPTS; attempt++) {
      const mode = readJournalMode(db);
      if (mode) return mode;
    }
    return '';
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${OPEN_BUSY_TIMEOUT_MS}`);
    } catch {
      // Non-fatal: the handle is still usable, and every path out of here
      // either throws or hands back a database that is already in WAL.
    }
  }
}

/**
 * Run `PRAGMA journal_mode = WAL`, retrying on contention (#1471).
 *
 * `busy_timeout` is set first and covers every other statement, but SQLite
 * does **not** invoke the busy handler for a journal-mode change — so the one
 * pragma the budget was put there for never gets it. Concurrent first-opens
 * of a fresh database therefore threw `SQLITE_BUSY` immediately and killed
 * whichever process lost the race: the daemon, the MCP server and a
 * foreground `flo` command starting together is the ordinary consumer
 * configuration, not a test artifact.
 *
 * Note the common path pays nothing: on a database already in WAL the pragma
 * is a no-op that takes no exclusive lock, so the first attempt succeeds with
 * no sleep and the loop below never runs.
 *
 * Twin: `bin/lib/get-backend.mjs:setWalWithRetry`. Must stay in lockstep until
 * Phase 5 (#1084) extracts a shared module.
 *
 * @internal exported for tests — `budgetMs` lets them exercise exhaustion
 *           without spending the real 15s.
 */
export function setWalWithRetry(
  db: WalPragmaTarget,
  dbPath: string,
  budgetMs: number = WAL_RETRY_BUDGET_MS,
): void {
  let lastErr: unknown = null;
  let waited = 0;
  let delay = WAL_RETRY_MIN_DELAY_MS;

  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      lastErr = err;
      // Anything that isn't contention — a corrupt file, a read-only mount —
      // will not clear by waiting. Surface it now rather than after 15s.
      if (!isBusyError(err)) throw err;
    }
    if (waited >= budgetMs) break;
    const nap = Math.min(delay, budgetMs - waited);
    sleepMs(nap);
    waited += nap;
    delay = Math.min(delay * 2, WAL_RETRY_MAX_DELAY_MS);
  }

  // Budget spent. Another opener may have completed the conversion while we
  // were losing races — the database being in WAL is the outcome we wanted,
  // whichever process got it there.
  const mode = readJournalModeBounded(db);
  if (mode === 'wal') return;

  throw new Error(
    `[moflo] PRAGMA journal_mode = WAL stayed busy for ${waited}ms on ${dbPath} ` +
    `(journal_mode is still "${mode || 'unreadable'}"). Another process is holding an ` +
    `exclusive lock on the database. Original error: ` +
    `${String((lastErr as Error | null)?.message ?? lastErr)}`,
    { cause: lastErr },
  );
}

/**
 * Read `journal_mode` back after we requested WAL. If the engine returned a
 * different mode (`delete`, `truncate`, `persist`, `memory`, `off`), the
 * underlying filesystem doesn't support WAL's shared-memory sidecar — a
 * strong signal that POSIX advisory locks are also unreliable. Surface a
 * one-line stderr warning naming the path so the user knows to move the
 * project off the network mount. Deduped per (path, process).
 *
 * Twin: `bin/lib/get-backend.mjs:warnIfNotWal`. Must stay in lockstep until
 * Phase 5 (#1084) extracts a shared module.
 */
function warnIfNotWal(db: DatabaseSync, dbPath: string): void {
  if (_networkFsWarnedPaths.has(dbPath)) return;
  // A probe that throws yields '' and falls through the guard below without
  // warning — the WAL pragma above either took effect or didn't, and a failed
  // read is not evidence either way.
  const mode = readJournalMode(db);
  if (mode && mode !== 'wal') {
    _networkFsWarnedPaths.add(dbPath);
    process.stderr.write(
      `[moflo] WARNING: SQLite journal_mode=${mode} on ${dbPath} (WAL not active). ` +
      `If this directory is on NFS/SMB or another network filesystem, POSIX ` +
      `advisory locks are unreliable and concurrent moflo processes can corrupt ` +
      `the database. Move the project to a local disk to restore multi-process safety.\n`,
    );
  }
}

/** @internal — test hook only (resets the dedupe set). */
export function _resetDaemonNetworkFsWarnings(): void {
  _networkFsWarnedPaths.clear();
}

/**
 * Heuristic: SQL is multi-statement if there's a `;` followed by anything
 * substantive. node:sqlite's `db.prepare()` does NOT throw on multi-statement
 * input — it silently parses only the first statement and discards the rest,
 * which is the worst possible failure mode for DDL batches like
 * `CREATE TABLE a; CREATE INDEX i; CREATE TABLE b;`. Detect explicitly and
 * route multi-stmt SQL to `db.exec()` (which runs every statement).
 *
 * The bridge + controller schema strings don't embed literal `;` inside
 * string literals, so the naive index-of check is sound. If that ever
 * changes, this needs a real tokeniser.
 */
function isMultiStatement(sql: string): boolean {
  const trimmed = sql.trimEnd();
  const semi = trimmed.indexOf(';');
  if (semi === -1) return false;
  return /\S/.test(trimmed.slice(semi + 1));
}

function execAsRowsNodeSqlite(
  db: DatabaseSync,
  sql: string,
  params?: unknown,
): Array<{ columns: string[]; values: unknown[][] }> {
  // Multi-statement DDL: route to db.exec() so every statement runs.
  // (sql.js's exec() runs every statement and returns row sets from any
  // that produce rows; the bridge code only reads [0]?.values, so DDL
  // batches correctly return []. Match that contract.)
  if (isMultiStatement(sql)) {
    db.exec(sql);
    return [];
  }
  let stmt: StatementSync;
  try {
    stmt = db.prepare(sql);
  } catch {
    // Last resort for any single-statement SQL that prepare rejects.
    db.exec(sql);
    return [];
  }
  const args = toParamsArray(params);
  const rows = (args.length > 0 ? stmt.all(...args) : stmt.all()) as Record<string, unknown>[];
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]);
  const values = rows.map((r) => columns.map((c) => r[c]));
  return [{ columns, values }];
}

/**
 * Open the daemon's memory DB handle. Always returns a node:sqlite-backed
 * adapter shaped like sql.js's Database so the existing bridge + controller
 * surface keeps working.
 *
 * @param dbPath disk path or `:memory:`
 */
export function openDaemonDatabase(dbPath: string): SqlJsLikeDatabase {
  // node:sqlite opens forgivingly even on non-SQLite files. Keep parity with
  // openSqlJsDatabase's "create if missing" semantic — DatabaseSync handles
  // file creation for us, BUT does NOT auto-create parent directories. The
  // bridge's first-init path commonly lands on a path whose parent .moflo/
  // doesn't exist yet (fresh consumer install, test fixtures with temp
  // project roots) — without the mkdir below, DatabaseSync throws ENOENT,
  // the controller-registry sets mofloDb=null, and the bridge silently
  // falls back to a raw-sql.js write rooted at process.cwd() (catastrophic
  // path drift bug; #1057 was about exactly this class of issue).
  if (dbPath !== ':memory:') {
    try { mkdirSync(dirname(dbPath), { recursive: true }); }
    catch { /* tolerate — DatabaseSync's ENOENT below is the real signal */ }
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    try {
      // busy_timeout MUST be set BEFORE journal_mode=WAL, because the WAL
      // pragma briefly takes an EXCLUSIVE lock and concurrent openers race
      // on it. Without busy_timeout in place, parallel doctor probes /
      // bridge initializations / indexer subprocess opens hit "database is
      // locked" and the bridge tears down (CI #1097). Order matters:
      //   1. busy_timeout — gives every subsequent pragma a retry budget
      //   2. journal_mode = WAL — needs the budget on contention
      //   3. synchronous — purely advisory, can come anytime
      //
      // Budget: 15000ms. The consumer-smoke harness exposes the realistic
      // worst case — a background indexer subprocess opens its own write
      // connection right after `npm install` and walks the entire consumer
      // tree (hundreds of guidance/skill files). The whole-tree first-pass
      // can hold a RESERVED/EXCLUSIVE lock for 5–8s while the doctor
      // foreground probe races against it. 5000ms was the original Phase 4
      // value and ran the budget out under that exact load on Windows CI
      // (#1098); 15000ms gives the indexer's full first-pass time to finish
      // before doctor's probe gives up. The price of being wrong-high here
      // is one slow probe per session, not lost data.
      db.exec(`PRAGMA busy_timeout = ${OPEN_BUSY_TIMEOUT_MS}`);
      // Not `db.exec` directly: SQLite skips the busy handler for a
      // journal-mode change, so this one pragma needs its own retry (#1471).
      setWalWithRetry(db, dbPath);
      db.exec('PRAGMA synchronous = NORMAL');
      // The daemon is the process most exposed to network-FS edge cases
      // (long-lived MCP server, ~30s of writes per indexer pass). NFS/SMB
      // mounts silently fall back from WAL to a rollback journal — surface
      // a one-line warning so the user knows to move the project off the
      // network mount. Mirrors `bin/lib/get-backend.mjs:warnIfNotWal`.
      warnIfNotWal(db, dbPath);
    } catch (err) {
      try {
        db.close();
      } catch {
        /* handle already dead */
      }
      throw err;
    }
  }

  // sql.js's `db.run(sql, params?)` and `prepare/run` share state; node:sqlite
  // requires fresh statements per call. Cache prepared statements keyed by SQL
  // text so the indexer-equivalent tight write loops don't churn the compiler.
  const runStmtCache = new Map<string, StatementSync>();
  let changesStmt: StatementSync | null = null;

  return {
    kind: 'node-sqlite',
    _raw: db,
    prepare(sql: string): SqlJsLikeStatement {
      return wrapStatement(db.prepare(sql));
    },
    run(sql: string, params?: unknown): unknown {
      const arr = toParamsArray(params);
      if (arr.length > 0) {
        let s = runStmtCache.get(sql);
        if (!s) {
          s = db.prepare(sql);
          runStmtCache.set(sql, s);
        }
        s.run(...arr);
      } else {
        db.exec(sql);
      }
      return undefined;
    },
    exec(sql: string, params?: unknown): Array<{ columns: string[]; values: unknown[][] }> {
      return execAsRowsNodeSqlite(db, sql, params);
    },
    getRowsModified(): number {
      if (!changesStmt) changesStmt = db.prepare('SELECT changes() AS c');
      const row = changesStmt.get() as { c?: number | bigint } | undefined;
      const c = row?.c ?? 0;
      return typeof c === 'bigint' ? Number(c) : c;
    },
    save(): void {
      // node:sqlite persists incrementally via WAL — no-op. The shape exists
      // so bridge-core's persistBridgeDb can call it unconditionally during
      // the Phase 4/5 transition window. Once everything routes through this
      // adapter, the explicit persist call becomes dead code (Phase 5).
    },
    export(): Uint8Array {
      // Bridge-core's old persist path used `db.export()` + atomicWriteFileSync.
      // node:sqlite ships a `serialize()` that returns the same shape so the
      // few callers that still need a buffer (e.g. tests, backup tooling) work.
      // The bridge-core persist call itself is being switched to `save()` so
      // this exists only as a safety net during the migration.
      const buf = db.prepare('SELECT 1').all();
      void buf;
      // Real serialize. node:sqlite added `DatabaseSync.prototype.serialize()`
      // in Node 22; the TS type for it landed later, so cast through the
      // engine's runtime API.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ser = (db as any).serialize?.();
      if (ser instanceof Uint8Array) return ser;
      if (ser && typeof ser === 'object' && 'buffer' in ser) return new Uint8Array(ser);
      // Last resort: read the file off disk. The caller knows the path; we
      // don't, so this branch should never fire under normal flow.
      return new Uint8Array();
    },
    close(): void {
      runStmtCache.clear();
      changesStmt = null;
      db.close();
    },
  };
}

/**
 * Seed an empty daemon DB from an existing file on disk. Equivalent to
 * sql.js's `new SQL.Database(readFileSync(path))` round-trip — node:sqlite
 * opens the path directly so this is just a wrapper that errors when the
 * file doesn't exist (existing callers expected the sql.js behaviour).
 */
export function openDaemonDatabaseFromFile(dbPath: string): SqlJsLikeDatabase {
  if (dbPath !== ':memory:' && !existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  // Touch readFileSync so callers that previously expected eager I/O still
  // observe the same failure shape (e.g. EACCES errors fire here, not
  // lazily on first query). node:sqlite would lazy-error otherwise.
  if (dbPath !== ':memory:') readFileSync(dbPath, { flag: 'r' });
  return openDaemonDatabase(dbPath);
}
