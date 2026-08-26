/**
 * Pure-JS factory for moflo.db low-level SQL handles — JS twin of the
 * `openDaemonDatabase` factory in `src/cli/memory/daemon-backend.ts`. Every
 * `bin/` script that opens `.moflo/moflo.db` MUST go through {@link openBackend}
 * so the engine choice stays consistent with the rest of the runtime.
 *
 * Backend selection: always `node:sqlite` (Phase 5 / #1084 — sql.js has been
 * deleted from the package). The `resolveBackend()` shim is retained because
 * a handful of tests still pass an explicit `backend` option; it now validates
 * the value but only honours `'node-sqlite'`.
 *
 * Engine surface — the handle exposes the **sql.js low-level Statement API**
 * because every existing bin/ caller was written against it (db.prepare/
 * stmt.bind/step/getAsObject/free/run, db.run/exec, db.export-via-save,
 * db.close). For `node:sqlite`, the adapter emulates `stmt.bind()/step()/
 * getAsObject()` via `StatementSync.iterate()` so callers don't refactor
 * their loops.
 *
 * Persistence semantics:
 *   - node:sqlite — writes through the OS file handle under WAL; `save()` is
 *     a no-op kept for API parity. WAL pragmas (`journal_mode=WAL`,
 *     `synchronous=NORMAL`, `busy_timeout=15000`) are set on first open per
 *     Phase 0 spike (#1079) and Phase 1 backend (#1080).
 *
 * @module bin/lib/get-backend
 */

// MUST come before any direct/transitive `node:sqlite` import below — the
// node:sqlite module fires ExperimentalWarning exactly once per process on
// first load, and once it fires there's no way to scrub it from stderr.
import './suppress-sqlite-warning.mjs';

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { memoryDbPath } from './moflo-paths.mjs';

// `node:sqlite` is loaded lazily so importing this module stays cheap for the
// scripts that only want `memoryDbPath`/`resolveBackend`. `createRequire` — not
// `await import` — because {@link openBackendSync} must stay synchronous: the
// per-step indexer gate (`index-fingerprint.decideStepGate`) is called from a
// sync decision path and needs a real DB read, not a promise.
const requireBuiltin = createRequire(import.meta.url);
let _DatabaseSync = null;
function databaseSyncCtor() {
  if (_DatabaseSync === null) _DatabaseSync = requireBuiltin('node:sqlite').DatabaseSync;
  return _DatabaseSync;
}

export const BACKEND_NODE_SQLITE = 'node-sqlite';

/**
 * Resolve the configured backend. Phase 5 (#1084) deleted the sql.js path,
 * so this always returns `node-sqlite`. The `opts.backend` parameter is kept
 * for API compatibility — anything else throws so a stale caller asking for
 * sql.js surfaces a clear error rather than silently dropping to the wrong
 * engine.
 *
 * @param {{ backend?: string }} [opts]
 * @returns {'node-sqlite'}
 */
export function resolveBackend(opts = {}) {
  if (opts.backend && opts.backend !== BACKEND_NODE_SQLITE) {
    throw new Error(
      `Unknown backend "${opts.backend}". moflo only supports "node-sqlite"; ` +
      `sql.js was retired in Phase 5 (#1084).`,
    );
  }
  return BACKEND_NODE_SQLITE;
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Open a low-level SQL backend handle. Defaults to `.moflo/moflo.db` under
 * `projectRoot`; pass `opts.dbPath` to point at a different file (used by
 * migrations that touch sibling DBs).
 *
 * @param {string} projectRoot
 * @param {{
 *   backend?: 'node-sqlite',
 *   create?: boolean,
 *   readOnly?: boolean,
 *   dbPath?: string,
 * }} [opts]
 * @returns {Promise<object>} backend handle (see module doc)
 */
export async function openBackend(projectRoot, opts = {}) {
  return openBackendSync(projectRoot, opts);
}

/**
 * Synchronous face of {@link openBackend}. Same implementation, same pragmas —
 * `openBackend` is retained as an async wrapper only because every existing
 * caller awaits it. Use this one from code that cannot await (the per-step
 * indexer gate); prefer `openBackend` everywhere else so the diff against the
 * TS twin stays obvious.
 *
 * @param {string} projectRoot
 * @param {{ backend?: 'node-sqlite', create?: boolean, readOnly?: boolean,
 *           dbPath?: string, busyTimeoutMs?: number }} [opts]
 *   `busyTimeoutMs` applies to READ-ONLY opens only (writers always get the
 *   15s WAL-trinity budget). Omit it to fail fast on contention.
 * @returns {object} backend handle (see module doc)
 */
export function openBackendSync(projectRoot, opts = {}) {
  const dbPath = opts.dbPath || memoryDbPath(projectRoot);
  resolveBackend(opts); // throws on stale sql.js callers
  // A read-only open must never materialise state: the indexer gate probes for
  // a DB that may legitimately not exist yet, and creating `.moflo/` from a
  // gate would be a side effect of asking a question.
  if (opts.readOnly !== true) ensureDir(dbPath);
  return openNodeSqlite(dbPath, opts);
}

// ---------------------------------------------------------------------------
// node:sqlite adapter — the only backend as of Phase 5 (#1084)
// ---------------------------------------------------------------------------

// Module-scope guard so we only fire the network-FS warning once per path
// per process — the indexer + daemon + bin/ scripts all open the same DB and
// we don't want N copies of the same message in one session.
const _networkFsWarnedPaths = new Set();

function openNodeSqlite(dbPath, opts) {
  const DatabaseSync = databaseSyncCtor();
  const readOnly = opts.readOnly === true;
  const db = new DatabaseSync(dbPath, { readOnly });
  if (readOnly) {
    // A read-only handle skips the WAL trinity (it cannot change journal
    // mode). It gets a retry budget ONLY when the caller asks for one.
    //
    // Applying the writer's 15s budget to every read-only open would be a
    // silent behaviour change for the readers that already exist —
    // `session-continuity.mjs` and `semantic-search.mjs` both open read-only
    // inside the session-start chain, and both are written to fail fast and
    // degrade. Turning an instant SQLITE_BUSY into a 15-second block for
    // them serialises the chain behind whatever holds the lock. Opt in, with
    // a budget sized to the caller's own patience.
    const budget = Number(opts.busyTimeoutMs) || 0;
    if (budget > 0) {
      try {
        db.exec(`PRAGMA busy_timeout = ${Math.floor(budget)}`);
      } catch {
        // Non-fatal: the handle is still usable, just without a retry budget.
      }
    }
  } else {
    // Close the handle on any PRAGMA failure — node:sqlite opens forgivingly
    // (even non-SQLite files succeed in the constructor) and a PRAGMA that
    // throws later would otherwise leak the file handle across processes
    // (visible on Windows as EPERM on subsequent rmdir of the parent).
    try {
      // WAL trinity validated by Phase 0 spike (#1079) and Phase 1 backend.
      // busy_timeout MUST be set BEFORE journal_mode=WAL — the WAL pragma
      // briefly takes an EXCLUSIVE lock, and concurrent openers (parallel
      // doctor probes, indexer subprocess, daemon bridge init) otherwise hit
      // "database is locked" with no retry budget. See #1097.
      // 15000ms — sized for the consumer-smoke worst case where a
      // background indexer holds a write lock for 5–8s during its first
      // full-tree pass after `npm install`. See daemon-backend.ts twin for
      // the full rationale (#1098).
      db.exec(`PRAGMA busy_timeout = ${OPEN_BUSY_TIMEOUT_MS}`);
      // Not `db.exec` directly: SQLite skips the busy handler for a
      // journal-mode change, so this one pragma needs its own retry (#1471).
      setWalWithRetry(db, dbPath);
      db.exec('PRAGMA synchronous = NORMAL');
      // Phase 4 / #1083 — network-FS detection. SQLite's POSIX advisory locks
      // and WAL shared-memory both fail silently on NFS/SMB; the engine falls
      // back to a non-WAL journal mode rather than erroring. Read journal_mode
      // back and warn if it isn't `wal`.
      if (dbPath !== ':memory:') warnIfNotWal(db, dbPath);
    } catch (err) {
      try { db.close(); } catch { /* already-dead handle */ }
      throw err;
    }
  }
  return wrapNodeSqlite(db, dbPath);
}

/**
 * Shared parking buffer for the journal-mode retry sleep. `Atomics.wait` is
 * the only synchronous sleep that behaves identically on Linux, macOS and
 * Windows without shelling out (Rule #1), and this open path is synchronous.
 */
const WAL_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

/** @param {number} ms */
function sleepMs(ms) {
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
 * already decided to give up.
 */
const WAL_PROBE_BUSY_TIMEOUT_MS = 500;
const WAL_PROBE_ATTEMPTS = 3;
/** See the daemon-backend.ts twin for the budget rationale (#1471). */
const WAL_RETRY_BUDGET_MS = OPEN_BUSY_TIMEOUT_MS;
const WAL_RETRY_MIN_DELAY_MS = 5;
const WAL_RETRY_MAX_DELAY_MS = 250;

/**
 * SQLITE_BUSY (5) and SQLITE_LOCKED (6). The message test is a fallback for
 * wrappers that don't propagate `errcode`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isBusyError(err) {
  const e = /** @type {{ errcode?: number, message?: string } | null} */ (err);
  if (e?.errcode === 5 || e?.errcode === 6) return true;
  return /database( table)? is locked/i.test(String(e?.message ?? ''));
}

/**
 * Current journal mode, lowercased. `''` when the probe itself fails.
 *
 * @param {object} db
 * @returns {string}
 */
function readJournalMode(db) {
  try {
    const row = db.prepare('PRAGMA journal_mode').get();
    return String(row?.journal_mode ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * `readJournalMode` under a deliberately narrow busy budget, restoring the
 * open-path budget afterwards so a caller that survives keeps the connection
 * it asked for. Only ever called once the retry budget is already spent.
 *
 * @param {object} db
 * @returns {string}
 */
function readJournalModeBounded(db) {
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
 * does NOT invoke the busy handler for a journal-mode change — so the one
 * pragma the budget was put there for never gets it, and concurrent
 * first-opens of a fresh database threw `SQLITE_BUSY` immediately, killing
 * whichever process lost the race. On a database already in WAL the pragma is
 * a no-op taking no exclusive lock, so the common path never enters the loop.
 *
 * Twin: `src/cli/memory/daemon-backend.ts:setWalWithRetry`. Keep in lockstep.
 *
 * @param {object} db node:sqlite DatabaseSync handle (or a test fake)
 * @param {string} dbPath
 * @param {number} [budgetMs]
 */
export function setWalWithRetry(db, dbPath, budgetMs = WAL_RETRY_BUDGET_MS) {
  let lastErr = null;
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
    `exclusive lock on the database. Original error: ${String(lastErr?.message ?? lastErr)}`,
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
 * Exported so the test in `tests/bin/get-backend.test.ts` can drive a real
 * non-WAL handle through the same probe (a local-disk DB will always come
 * back as WAL, so we can't trigger the warning by simply opening a DB).
 *
 * @param {object} db node:sqlite DatabaseSync handle
 * @param {string} dbPath
 */
export function warnIfNotWal(db, dbPath) {
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
      `the database. Move the project to a local disk to restore multi-process safety.\n`
    );
  }
}

/** @internal — test hook only (resets the dedupe set). */
export function _resetNetworkFsWarnings() {
  _networkFsWarnedPaths.clear();
}

function wrapNodeSqlite(db, dbPath) {
  // node:sqlite has no `db.changes` field, so the rowsModified probe is a
  // tiny prepared statement reused across calls — preparing on every probe
  // would dominate the indexer's tight write loops.
  let changesStmt = null;
  const getChanges = () => {
    if (!changesStmt) changesStmt = db.prepare('SELECT changes() AS c');
    const row = changesStmt.get();
    return Number(row?.c ?? 0);
  };

  // Per-connection prepare cache for `db.run(sql, params)` calls — without
  // this the indexer's bulk-DELETE loop (index-guidance:698,699,717) allocates
  // a fresh StatementSync per row, churning the engine's compile cache.
  const runStmtCache = new Map();
  const runWithParams = (sql, params) => {
    let s = runStmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      runStmtCache.set(sql, s);
    }
    s.run(...params);
  };

  return {
    kind: BACKEND_NODE_SQLITE,
    prepare: (sql) => wrapNodeSqliteStmt(db.prepare(sql)),
    run: (sql, params) => {
      if (params && params.length > 0) runWithParams(sql, params);
      else db.exec(sql);
    },
    exec: (sql) => execAsRowsNodeSqlite(db, sql),
    getRowsModified: getChanges,
    save: () => {
      // node:sqlite persists incrementally via WAL — explicit save is a no-op.
      // Callers can still invoke `save()` unconditionally; the API parity
      // matters more than micro-optimising one call away.
    },
    close: () => {
      changesStmt = null;
      runStmtCache.clear();
      db.close();
    },
    _raw: db,
  };
}

/**
 * Heuristic match for multi-statement SQL: `;` followed by anything
 * substantive. node:sqlite's `db.prepare()` does NOT throw on multi-statement
 * input — it silently parses the first statement only and drops the rest,
 * which is the worst possible failure mode for DDL batches like
 * `CREATE TABLE a; CREATE INDEX i; CREATE TABLE b;`. Detect and route
 * multi-stmt SQL to `db.exec()` (which runs every statement).
 */
function isMultiStatement(sql) {
  const trimmed = sql.trimEnd();
  const semi = trimmed.indexOf(';');
  if (semi === -1) return false;
  return /\S/.test(trimmed.slice(semi + 1));
}

/**
 * Adapt node:sqlite to sql.js's `db.exec(sql)` return shape:
 * `[{ columns: string[], values: any[][] }]`. The bin scripts use this for
 * single-statement queries that return rows (`PRAGMA integrity_check` in
 * `db-repair.mjs`, `SELECT COUNT(*)` in `index-guidance.mjs`) and for
 * multi-statement DDL batches (controller `ensureSchema`).
 */
function execAsRowsNodeSqlite(db, sql) {
  // Multi-statement DDL: db.exec() runs every statement. Matches sql.js's
  // exec() contract — DDL batches return `[]` (no row results to surface).
  if (isMultiStatement(sql)) {
    db.exec(sql);
    return [];
  }
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch {
    db.exec(sql);
    return [];
  }
  const rows = stmt.all();
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]);
  const values = rows.map((r) => columns.map((c) => r[c]));
  return [{ columns, values }];
}

function wrapNodeSqliteStmt(stmt) {
  // sql.js statements are stateful (bind → step* → free); node:sqlite's
  // StatementSync is stateless (each call takes its own params). The shim
  // captures the pending params and lazily opens an iterator on first
  // `step()`, releasing the iterator on `free()` so the next `bind()`+
  // `step()` cycle starts cleanly.
  let pendingParams = null;
  let iter = null;
  let currentRow = null;
  return {
    bind: (params) => {
      pendingParams = params && params.length > 0 ? params : null;
      iter = null;
      currentRow = null;
    },
    step: () => {
      if (!iter) {
        iter = pendingParams ? stmt.iterate(...pendingParams) : stmt.iterate();
      }
      const next = iter.next();
      if (next.done) {
        currentRow = null;
        return false;
      }
      currentRow = next.value;
      return true;
    },
    getAsObject: () => currentRow || {},
    run: (params) => {
      if (params && params.length > 0) stmt.run(...params);
      else stmt.run();
    },
    free: () => {
      // sql.js's `Statement.free()` finalises the underlying statement;
      // node:sqlite has no per-statement finalize (StatementSync is GC'd
      // when the Database closes). The wrapper's `free()` instead resets
      // the iteration state so the next `bind()`+`step()` cycle starts
      // cleanly. Functional parity with sql.js callers despite the
      // different underlying lifecycle.
      iter = null;
      currentRow = null;
      pendingParams = null;
    },
  };
}
