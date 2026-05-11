/**
 * Pure-JS factory for moflo.db low-level SQL handles — JS twin of the engine
 * selection in `src/cli/memory/database-provider.ts`. Every `bin/` script that
 * opens `.moflo/moflo.db` MUST go through {@link openBackend} so the engine
 * can be swapped in one place (epic #1078 Phase 2 / issue #1081).
 *
 * Engine selection priority:
 *   1. `opts.backend` — explicit override (used by tests + internal shadow-read wrapper)
 *   2. Default: `'node-sqlite'` (Phase 4 flip / issue #1083)
 *
 * No env-var escape hatch: if node:sqlite surfaces a regression in production,
 * the rollback path is `npm install moflo@<previous>` rather than carrying a
 * `MOFLO_DB_BACKEND` env var we'd have to sunset in Phase 5. Phase 5 (#1084)
 * deletes the sql.js adapter and dep entirely.
 *
 * The handle exposes the **sql.js low-level Statement API** because that's
 * what every existing bin/ caller already uses (db.prepare/stmt.bind/step/
 * getAsObject/free/run, db.run/exec, db.export-via-save, db.close). For
 * `node:sqlite`, the adapter emulates `stmt.bind()/step()/getAsObject()` via
 * `StatementSync.iterate()` so callers don't refactor their loops.
 *
 * Persistence semantics:
 *   - sql.js — in-memory snapshot; `backend.save()` writes the full buffer to
 *     disk via `writeFileSync(path, Buffer.from(db.export()))`.
 *   - node:sqlite — writes through the OS file handle under WAL; `save()` is
 *     a no-op. WAL pragmas (`journal_mode=WAL`, `synchronous=NORMAL`,
 *     `busy_timeout=5000`) are set on first open per Phase 0 spike (#1079)
 *     and Phase 1 backend (#1080).
 *
 * @module bin/lib/get-backend
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Buffer } from 'node:buffer';
import { mofloResolveURL } from './moflo-resolve.mjs';
import { memoryDbPath } from './moflo-paths.mjs';
import {
  resolveShadow,
  shadowDbPath,
  seedShadowFile,
  shadowStrictMode,
  wrapShadow,
} from './shadow-backend.mjs';

export const BACKEND_SQLJS = 'sql.js';
export const BACKEND_NODE_SQLITE = 'node-sqlite';

/**
 * Resolve the configured backend. Defaults to `node-sqlite` (Phase 4 / #1083).
 * The only override is `opts.backend` — used by the shadow-read wrapper to
 * open the off-engine sibling and by tests. There is no env-var escape hatch;
 * rolling back means installing the previous moflo version.
 *
 * @param {{ backend?: string }} [opts]
 * @returns {'sql.js'|'node-sqlite'}
 */
export function resolveBackend(opts = {}) {
  if (opts.backend === BACKEND_SQLJS || opts.backend === BACKEND_NODE_SQLITE) {
    return opts.backend;
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
 * When shadow-read is on (epic #1078 Phase 3 / issue #1082) the primary
 * engine opens normally and the shadow engine (the other one) opens
 * against a sibling `.moflo/moflo.shadow.db` seeded from the primary at
 * open time. The returned handle mirrors every write to both engines and
 * compares results on reads — see `bin/lib/shadow-backend.mjs`.
 *
 * @param {string} projectRoot
 * @param {{
 *   backend?: 'sql.js'|'node-sqlite',
 *   create?: boolean,
 *   readOnly?: boolean,
 *   dbPath?: string,
 *   shadow?: boolean,
 * }} [opts]
 * @returns {Promise<object>} backend handle (see module doc)
 */
export async function openBackend(projectRoot, opts = {}) {
  const dbPath = opts.dbPath || memoryDbPath(projectRoot);
  const kind = resolveBackend(opts);
  ensureDir(dbPath);
  if (resolveShadow(projectRoot, opts) && !opts.dbPath) {
    return openWithShadow(projectRoot, kind, dbPath, opts);
  }
  return openOne(kind, dbPath, opts);
}

async function openOne(kind, dbPath, opts) {
  if (kind === BACKEND_NODE_SQLITE) return openNodeSqlite(dbPath, opts);
  return openSqlJs(dbPath, opts);
}

async function openWithShadow(projectRoot, primaryKind, primaryPath, opts) {
  const shadowKind = primaryKind === BACKEND_SQLJS ? BACKEND_NODE_SQLITE : BACKEND_SQLJS;
  const shadowPath = shadowDbPath(projectRoot);
  ensureDir(shadowPath);
  seedShadowFile(primaryPath, shadowPath);
  const primary = await openOne(primaryKind, primaryPath, opts);
  const shadow = await openOne(shadowKind, shadowPath, opts);
  return wrapShadow(primary, shadow, {
    projectRoot,
    strict: shadowStrictMode(),
  });
}

// ---------------------------------------------------------------------------
// sql.js adapter — kept for shadow-read pairing + opt-in via opts.backend
// (Phase 5 / #1084 deletes this adapter and the npm dep together).
// ---------------------------------------------------------------------------

let _initSqlJsCached = null;

async function loadSqlJs() {
  if (_initSqlJsCached) return _initSqlJsCached;
  const mod = await import(mofloResolveURL('sql.js'));
  _initSqlJsCached = mod.default || mod;
  return _initSqlJsCached;
}

async function openSqlJs(dbPath, opts) {
  const initSqlJs = await loadSqlJs();
  const SQL = await initSqlJs();
  let db;
  if (existsSync(dbPath)) {
    db = new SQL.Database(readFileSync(dbPath));
  } else if (opts.create !== false && opts.readOnly !== true) {
    db = new SQL.Database();
  } else {
    throw new Error(`Database not found: ${dbPath}`);
  }
  return wrapSqlJs(db, dbPath);
}

function wrapSqlJs(db, dbPath) {
  return {
    kind: BACKEND_SQLJS,
    prepare: (sql) => wrapSqlJsStmt(db.prepare(sql)),
    run: (sql, params) => {
      if (params && params.length > 0) db.run(sql, params);
      else db.run(sql);
    },
    exec: (sql) => db.exec(sql),
    getRowsModified: () => db.getRowsModified(),
    save: () => writeFileSync(dbPath, Buffer.from(db.export())),
    close: () => db.close(),
    _raw: db,
  };
}

function wrapSqlJsStmt(stmt) {
  return {
    bind: (params) => stmt.bind(params || []),
    step: () => stmt.step(),
    getAsObject: () => stmt.getAsObject(),
    run: (params) => {
      if (params && params.length > 0) stmt.run(params);
      else stmt.run();
    },
    free: () => stmt.free(),
  };
}

// ---------------------------------------------------------------------------
// node:sqlite adapter — default backend as of Phase 4 (#1083)
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
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA busy_timeout = 5000');
      // Phase 4 / #1083 — network-FS detection. SQLite's POSIX advisory locks
      // and WAL shared-memory both fail silently on NFS/SMB; the engine falls
      // back to a non-WAL journal mode rather than erroring. sql.js never had
      // this problem because it didn't take file locks at all, so consumers
      // running moflo on network-mounted home dirs would silently lose
      // multi-process safety after the default flip. Read journal_mode back
      // and warn if it isn't `wal`.
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
