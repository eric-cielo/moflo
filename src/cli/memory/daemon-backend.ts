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
      // sql.js `Statement.get()` returns positional values. We emulate by
      // reading the row object via getAsObject() and projecting to positional
      // via the column-name list. Callers that pass params re-bind first.
      if (params !== undefined) {
        pendingParams = toParamsArray(params);
        iter = null;
      }
      ensureIter();
      const next = iter!.next();
      if (next.done) return [];
      const row = next.value as Record<string, unknown>;
      const cols = columnNamesCache ?? Object.keys(row);
      columnNamesCache = cols;
      return cols.map((c) => row[c]);
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
  let mode: string | undefined;
  try {
    const stmt = db.prepare('PRAGMA journal_mode');
    const row = stmt.get() as { journal_mode?: string } | undefined;
    mode = String(row?.journal_mode ?? '').toLowerCase();
  } catch {
    return;
  }
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

function execAsRowsNodeSqlite(
  db: DatabaseSync,
  sql: string,
  params?: unknown,
): Array<{ columns: string[]; values: unknown[][] }> {
  let stmt: StatementSync;
  try {
    stmt = db.prepare(sql);
  } catch {
    // Non-SELECT statements (CREATE/INSERT batches separated by `;`) don't
    // prepare cleanly. Fall back to raw exec so DDL strings still go through.
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
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA busy_timeout = 5000');
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
