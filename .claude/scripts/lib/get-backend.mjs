/**
 * Pure-JS factory for moflo.db low-level SQL handles — JS twin of the engine
 * selection in `src/cli/memory/database-provider.ts`. Every `bin/` script that
 * opens `.moflo/moflo.db` MUST go through {@link openBackend} so the engine
 * can be swapped in one place (epic #1078 Phase 2 / issue #1081).
 *
 * Engine selection priority:
 *   1. `opts.backend` — explicit override (used by tests + the TS factory)
 *   2. `MOFLO_DB_BACKEND` env var — `'node-sqlite'` or `'sql.js'`
 *   3. Default: `'sql.js'` (Phase 4 will flip to `'node-sqlite'`)
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
 * Resolve the configured backend. Honours the explicit `opts.backend`
 * override first, then `MOFLO_DB_BACKEND`, then defaults to `sql.js`. Pure
 * function — callers can use it directly to log the selected engine.
 *
 * @param {{ backend?: string }} [opts]
 * @returns {'sql.js'|'node-sqlite'}
 */
export function resolveBackend(opts = {}) {
  if (opts.backend === BACKEND_SQLJS || opts.backend === BACKEND_NODE_SQLITE) {
    return opts.backend;
  }
  const env = (process.env.MOFLO_DB_BACKEND || '').trim();
  if (env === BACKEND_NODE_SQLITE) return BACKEND_NODE_SQLITE;
  return BACKEND_SQLJS;
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
// sql.js adapter — current default
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
// node:sqlite adapter — Phase 1 backend behind MOFLO_DB_BACKEND=node-sqlite
// ---------------------------------------------------------------------------

async function openNodeSqlite(dbPath, opts) {
  const { DatabaseSync } = await import('node:sqlite');
  const readOnly = opts.readOnly === true;
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    // WAL trinity validated by Phase 0 spike (#1079) and Phase 1 backend.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return wrapNodeSqlite(db, dbPath);
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
