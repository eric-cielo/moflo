/**
 * Shadow-read wrapper for the moflo.db backend factory — Phase 3 of epic
 * #1078 (sql.js → node:sqlite migration). Lives next to `get-backend.mjs`
 * but in its own module so the factory stays small and the shadow surface
 * can be audited as a single unit.
 *
 * What it does:
 *   1. When opt-in is on, opens the **primary** backend (chosen by
 *      `resolveBackend(opts)` — sql.js by default until Phase 4) AND the
 *      **shadow** backend (the other engine) against a sibling file
 *      `.moflo/moflo.shadow.db` seeded by copying the primary at open time.
 *   2. Mirrors every mutation (`run`, `exec`, prepared `run`) to both so
 *      the shadow stays apples-to-apples with the primary.
 *   3. On reads (`exec(sql)` returning rows, `prepare(sql).step()` /
 *      `getAsObject()`) runs both, compares row shape + values, and logs
 *      every divergence to stderr + `.moflo/shadow-divergence.log` (JSONL).
 *   4. `MOFLO_DB_SHADOW_STRICT=1` re-throws on divergence — used by tests
 *      so a single mismatch fails the suite.
 *
 * Why a sibling file (not the same `.moflo/moflo.db`):
 *   sql.js writes by overwriting the whole file (`save()` → tmpfile +
 *   rename), node:sqlite writes incrementally under WAL. Opening both
 *   against the same file would let the sql.js dump clobber the
 *   node:sqlite writes (the exact bug class this epic is killing). Each
 *   engine gets its own file; they're seeded identically and the shadow
 *   stays in lockstep via mirrored writes.
 *
 * @module bin/lib/shadow-backend
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { mofloDir } from './moflo-paths.mjs';

const SHADOW_DB_FILE = 'moflo.shadow.db';
const SHADOW_LOG_FILE = 'shadow-divergence.log';

/**
 * Resolve whether shadow-read is enabled. Precedence:
 *   1. `opts.shadow` — explicit boolean override (tests)
 *   2. `MOFLO_DB_SHADOW` env var — `'1'` / `'true'` / `'on'` → enabled
 *   3. `moflo.yaml` → `memory.shadow_read: true` under `projectRoot`
 *   4. Default: `false`
 *
 * @param {string} projectRoot
 * @param {{ shadow?: boolean }} [opts]
 * @returns {boolean}
 */
export function resolveShadow(projectRoot, opts = {}) {
  if (typeof opts.shadow === 'boolean') return opts.shadow;
  const env = (process.env.MOFLO_DB_SHADOW || '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'off') return false;
  return readShadowReadFromYaml(projectRoot);
}

let _yamlCache = new Map();
function readShadowReadFromYaml(projectRoot) {
  if (_yamlCache.has(projectRoot)) return _yamlCache.get(projectRoot);
  let value = false;
  try {
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    if (existsSync(yamlPath)) {
      const content = readFileSync(yamlPath, 'utf-8');
      // memory:\n  ...\n  shadow_read: true   (block scope; same regex shape
      // as index-all.mjs's auto_index block reader — avoids a js-yaml dep).
      const re = /memory:\s*\n(?:[ \t]+.*\n)*?[ \t]+shadow_read:\s*(true|false)/;
      const match = content.match(re);
      if (match) value = match[1] === 'true';
    }
  } catch {
    /* default false on read error */
  }
  _yamlCache.set(projectRoot, value);
  return value;
}

/** Test-only — invalidate the moflo.yaml read cache. */
export function _resetYamlCache() {
  _yamlCache = new Map();
}

/**
 * Path the shadow DB is written to. Exported so tests can assert primary
 * `.moflo/moflo.db` is never used by the non-default engine.
 */
export function shadowDbPath(projectRoot) {
  return join(mofloDir(projectRoot), SHADOW_DB_FILE);
}

export function shadowLogPath(projectRoot) {
  return join(mofloDir(projectRoot), SHADOW_LOG_FILE);
}

/**
 * Seed the shadow DB from the primary so both engines see identical state
 * at the start of the session. Always overwrites — a stale shadow file
 * from a previous session would emit false divergences forever.
 */
export function seedShadowFile(primaryPath, shadowPath) {
  if (existsSync(primaryPath)) {
    copyFileSync(primaryPath, shadowPath);
  }
  // WAL sidecars from a previous node:sqlite session would re-apply stale
  // transactions on the next open. Drop them so the seed is the source of
  // truth.
  for (const ext of ['-wal', '-shm']) {
    try {
      if (existsSync(shadowPath + ext)) unlinkSync(shadowPath + ext);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Wrap a primary + shadow backend pair so callers see the regular sql.js-
 * shaped API but every operation is mirrored + (for reads) compared.
 *
 * @param {object} primary  — primary backend handle from `wrapSqlJs`/`wrapNodeSqlite`
 * @param {object} shadow   — shadow backend handle (the other engine)
 * @param {{ projectRoot: string, strict: boolean }} ctx
 * @returns {object} sql.js-shaped backend handle (forwarded from primary)
 */
export function wrapShadow(primary, shadow, ctx) {
  const reporter = makeReporter(ctx);
  return {
    kind: primary.kind, // callers see the primary's identity
    shadowKind: shadow.kind, // surfaced for diagnostics + tests
    prepare: (sql) => wrapShadowStmt(primary.prepare(sql), shadow.prepare(sql), sql, reporter),
    run: (sql, params) => {
      primary.run(sql, params);
      try {
        shadow.run(sql, params);
      } catch (err) {
        reporter.report({ op: 'run', sql, primaryRows: null, shadowRows: null, error: String(err) });
      }
    },
    exec: (sql) => {
      const primaryRows = primary.exec(sql);
      let shadowRows = null;
      try {
        shadowRows = shadow.exec(sql);
      } catch (err) {
        reporter.report({ op: 'exec', sql, primaryRows, shadowRows: null, error: String(err) });
        return primaryRows;
      }
      compareExecRows(sql, primaryRows, shadowRows, reporter);
      return primaryRows;
    },
    getRowsModified: () => {
      const a = primary.getRowsModified();
      const b = shadow.getRowsModified();
      if (a !== b) reporter.report({ op: 'getRowsModified', primary: a, shadow: b });
      return a;
    },
    save: () => {
      primary.save();
      shadow.save();
    },
    close: () => {
      try { primary.close(); } finally { shadow.close(); }
    },
    _primary: primary,
    _shadow: shadow,
  };
}

function wrapShadowStmt(primaryStmt, shadowStmt, sql, reporter) {
  return {
    bind: (params) => {
      primaryStmt.bind(params);
      try {
        shadowStmt.bind(params);
      } catch (err) {
        reporter.report({ op: 'bind', sql, error: String(err) });
      }
    },
    step: () => {
      const a = primaryStmt.step();
      let b = false;
      try {
        b = shadowStmt.step();
      } catch (err) {
        reporter.report({ op: 'step', sql, error: String(err) });
        return a;
      }
      if (a !== b) {
        reporter.report({ op: 'step', sql, primaryStep: a, shadowStep: b });
        return a;
      }
      if (a) {
        const ra = primaryStmt.getAsObject();
        const rb = shadowStmt.getAsObject();
        if (!rowsEqual(ra, rb)) {
          reporter.report({
            op: 'step.row',
            sql,
            primaryRow: serialiseRow(ra),
            shadowRow: serialiseRow(rb),
          });
        }
      }
      return a;
    },
    getAsObject: () => primaryStmt.getAsObject(),
    run: (params) => {
      primaryStmt.run(params);
      try {
        shadowStmt.run(params);
      } catch (err) {
        reporter.report({ op: 'stmt.run', sql, error: String(err) });
      }
    },
    free: () => {
      primaryStmt.free();
      shadowStmt.free();
    },
  };
}

function compareExecRows(sql, primaryRows, shadowRows, reporter) {
  if (!Array.isArray(primaryRows) || !Array.isArray(shadowRows)) {
    if (primaryRows !== shadowRows) {
      reporter.report({ op: 'exec.shape', sql, primary: typeof primaryRows, shadow: typeof shadowRows });
    }
    return;
  }
  if (primaryRows.length !== shadowRows.length) {
    reporter.report({ op: 'exec.length', sql, primary: primaryRows.length, shadow: shadowRows.length });
    return;
  }
  for (let i = 0; i < primaryRows.length; i++) {
    const pa = primaryRows[i];
    const pb = shadowRows[i];
    if (!arrayShallowEqual(pa.columns, pb.columns)) {
      reporter.report({ op: 'exec.columns', sql, idx: i, primary: pa.columns, shadow: pb.columns });
      return;
    }
    if (!values2dEqual(pa.values, pb.values)) {
      reporter.report({
        op: 'exec.values',
        sql,
        idx: i,
        primaryRows: pa.values?.length ?? 0,
        shadowRows: pb.values?.length ?? 0,
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Equality helpers — handle the engine-specific quirks. node:sqlite returns
// rows as `Object: null prototype`; BLOBs come back as Uint8Array (node:sqlite)
// vs Uint8Array via SQL.js's Statement.get(). Compare bytes, not refs.
// ---------------------------------------------------------------------------

function rowsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!valuesEqual(a[k], b[k])) return false;
  }
  return true;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  // Numeric equality across int/BigInt — node:sqlite returns INTEGERs as
  // number when safe; sql.js always returns number. Coerce for comparison.
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return BigInt(a) === BigInt(b);
  }
  if (isBytes(a) && isBytes(b)) return bytesEqual(a, b);
  // Float drift — engines should produce identical values, but defend
  // against IEEE re-rounding on cross-platform builds.
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  return a === b;
}

function isBytes(v) {
  return v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(v));
}

function bytesEqual(a, b) {
  // Buffer.compare accepts both Buffer and Uint8Array since Node 12.
  return Buffer.compare(a, b) === 0;
}

function arrayShallowEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function values2dEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (!Array.isArray(ra) || !Array.isArray(rb)) return false;
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) {
      if (!valuesEqual(ra[j], rb[j])) return false;
    }
  }
  return true;
}

function serialiseRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (isBytes(v)) out[k] = `<bytes:${v.length}>`;
    else if (typeof v === 'bigint') out[k] = String(v);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Divergence reporter — stderr + JSONL log + optional strict-mode throw.
// ---------------------------------------------------------------------------

function makeReporter({ projectRoot, strict }) {
  const logPath = shadowLogPath(projectRoot);
  return {
    report(entry) {
      const ts = new Date().toISOString();
      const row = { ts, ...entry };
      const line = JSON.stringify(row);
      // stderr first — visible during dogfood runs even if disk is full.
      try {
        process.stderr.write(`[shadow-read] ${line}\n`);
      } catch {
        /* stderr may be detached in some test harnesses */
      }
      try {
        appendFileSync(logPath, line + '\n');
      } catch {
        /* best-effort — disk full / read-only fs shouldn't kill the caller */
      }
      if (strict) {
        const err = new Error(`Shadow-read divergence (strict mode): ${line}`);
        err.shadowDivergence = row;
        throw err;
      }
    },
  };
}

export function shadowStrictMode() {
  const v = (process.env.MOFLO_DB_SHADOW_STRICT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
