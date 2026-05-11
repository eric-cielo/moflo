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
 *     `synchronous=NORMAL`, `busy_timeout=5000`) are set on first open per
 *     Phase 0 spike (#1079) and Phase 1 backend (#1080).
 *
 * @module bin/lib/get-backend
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { memoryDbPath } from './moflo-paths.mjs';

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
  const dbPath = opts.dbPath || memoryDbPath(projectRoot);
  resolveBackend(opts); // throws on stale sql.js callers
  ensureDir(dbPath);
  return openNodeSqlite(dbPath, opts);
}

// ---------------------------------------------------------------------------
// node:sqlite adapter — the only backend as of Phase 5 (#1084)
// ---------------------------------------------------------------------------

// Module-scope guard so we only fire the network-FS warning once per path
// per process — the indexer + daemon + bin/ scripts all open the same DB and
// we don't want N copies of the same message in one session.
const _networkFsWarnedPaths = new Set();

async function openNodeSqlite(dbPath, opts) {
  const { DatabaseSync } = await import('node:sqlite');
  const readOnly = opts.readOnly === true;
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
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
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
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
  let mode;
  try {
    const stmt = db.prepare('PRAGMA journal_mode');
    const row = stmt.get();
    mode = String(row?.journal_mode ?? '').toLowerCase();
  } catch {
    // Probe must never break the open path — silent failure is acceptable
    // because the WAL pragma above already either took effect or didn't.
    return;
  }
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
 * Adapt node:sqlite to sql.js's `db.exec(sql)` return shape:
 * `[{ columns: string[], values: any[][] }]`. The bin scripts use this for
 * single-statement queries that return rows (`PRAGMA integrity_check` in
 * `db-repair.mjs`, `SELECT COUNT(*)` in `index-guidance.mjs`).
 *
 * The catch ONLY wraps `db.prepare()` — multi-statement SQL is the one shape
 * that fails preparation but is accepted by `db.exec()`. Errors thrown by
 * `stmt.all()` (constraint violations, runtime SQL errors) propagate up so
 * the caller never silently swallows them OR re-executes side-effecting DDL.
 */
function execAsRowsNodeSqlite(db, sql) {
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch {
    // Multi-statement SQL — node:sqlite's prepare rejects it. Fall back to
    // exec which discards rows (caller of multi-statement exec doesn't read
    // the return value; matches sql.js for DDL).
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
