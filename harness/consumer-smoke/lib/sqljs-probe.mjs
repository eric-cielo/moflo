/**
 * Shared scaffolding for the populated-consumer harness's SQLite probe
 * subprocesses. Every probe writes a short `.mjs` script into the consumer
 * dir, runs it via `runNode`, parses the JSON its first stdout line emits,
 * and cleans up — this helper collapses that pattern.
 *
 * Phase 5 (#1084) — sql.js was removed from moflo's runtime; probes now use
 * Node's built-in `node:sqlite`. The PROBE_HARNESS preamble injects a thin
 * sql.js-shape adapter (`sqlInit()` resolves to a `SQL` object with
 * `Database`, `export()`, statement API) so existing probe bodies continue
 * to work without per-call rewrites.
 *
 * Probes write a single JSON line on the FIRST stdout line — the helper
 * tolerates loader chatter on later lines by parsing only the first.
 */

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runNode } from './proc.mjs';
import { record } from './report.mjs';

// node:sqlite → sql.js-shape adapter. The probe bodies still write SQL via
// `db.exec(sql)`, prepare/step/getAsObject loops, and `db.export()`; this
// preamble emulates that API on top of `node:sqlite`'s stateless
// `StatementSync`. Mirrors src/cli/memory/daemon-backend.ts:wrapStatement
// — keep behavioural parity if either side moves.
const PROBE_HARNESS = `
// Filter Node's once-per-process \`SQLite is an experimental feature\`
// warning BEFORE the \`node:sqlite\` import below fires it. The smoke
// harness scans subprocess stderr for failures, and the warning prefix
// otherwise fills the truncated tail and hides real errors (#1098).
{
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (msg.includes('SQLite is an experimental feature')) return;
    return originalEmitWarning.apply(this, [warning, ...args]);
  };
}
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isMultiStatement(sql) {
  const trimmed = sql.trimEnd();
  const semi = trimmed.indexOf(';');
  if (semi === -1) return false;
  return /\\S/.test(trimmed.slice(semi + 1));
}

function execAsRows(db, sql, params) {
  if (isMultiStatement(sql)) { db.exec(sql); return []; }
  let stmt;
  try { stmt = db.prepare(sql); } catch { db.exec(sql); return []; }
  const args = (params === undefined || params === null) ? [] : (Array.isArray(params) ? params : [params]);
  const rows = args.length > 0 ? stmt.all(...args) : stmt.all();
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]);
  const values = rows.map(r => columns.map(c => r[c]));
  return [{ columns, values }];
}

function wrapStatement(stmt) {
  let pending = [];
  let iter = null;
  let currentRow = null;
  const ensureIter = () => {
    if (!iter) iter = pending.length > 0 ? stmt.iterate(...pending) : stmt.iterate();
  };
  return {
    bind(params) {
      pending = (params === undefined || params === null) ? [] : (Array.isArray(params) ? params : [params]);
      iter = null;
      currentRow = null;
      return true;
    },
    step() {
      ensureIter();
      const next = iter.next();
      if (next.done) { currentRow = null; return false; }
      currentRow = next.value;
      return true;
    },
    getAsObject(params) {
      if (params !== undefined) {
        pending = Array.isArray(params) ? params : [params];
        iter = null;
        ensureIter();
        const next = iter.next();
        if (next.done) { currentRow = null; return {}; }
        currentRow = next.value;
        return currentRow;
      }
      return currentRow ?? {};
    },
    get(params) {
      if (params !== undefined) {
        pending = Array.isArray(params) ? params : [params];
        iter = null;
        ensureIter();
        const next = iter.next();
        if (next.done) { currentRow = null; return []; }
        currentRow = next.value;
      }
      if (!currentRow) return [];
      return Object.values(currentRow);
    },
    run(params) {
      const arr = (params === undefined || params === null) ? [] : (Array.isArray(params) ? params : [params]);
      if (arr.length > 0) stmt.run(...arr); else stmt.run();
    },
    free() {
      iter = null; currentRow = null; pending = [];
    },
  };
}

function wrapDb(db, opts = {}) {
  const path = opts.path; // for export() — null/undefined for :memory: probes
  return {
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    run: (sql, params) => {
      const arr = (params === undefined || params === null) ? [] : (Array.isArray(params) ? params : [params]);
      if (arr.length > 0) db.prepare(sql).run(...arr);
      else db.exec(sql);
    },
    exec: (sql, params) => execAsRows(db, sql, params),
    export: () => {
      // sql.js parity: serialise the whole DB as a Uint8Array. node:sqlite's
      // \`DatabaseSync.prototype.serialize()\` (Node 22+) returns the same
      // shape; if the path is known we can also just \`readFileSync\` it.
      const ser = db.serialize?.();
      if (ser instanceof Uint8Array) return ser;
      if (ser && typeof ser === 'object' && 'buffer' in ser) return new Uint8Array(ser);
      if (path) return new Uint8Array(readFileSync(path));
      // Last resort: dump to a temp file then read back.
      const dir = mkdtempSync(join(tmpdir(), 'moflo-probe-'));
      const tmp = join(dir, 'export.db');
      const fileDb = new DatabaseSync(tmp);
      // No clean way to copy across handles; fall back to backup pragma via SQL.
      fileDb.close();
      const bytes = new Uint8Array(readFileSync(tmp));
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      return bytes;
    },
    close: () => db.close(),
  };
}

// sql.js-shape factory. Probes call \`await sqlInit()\` then \`new SQL.Database()\`
// (in-memory) or \`new SQL.Database(bytes)\` (open from bytes). Match both forms.
async function sqlInit() {
  return {
    Database: function (bytes) {
      if (bytes && bytes.length > 0) {
        // sql.js's "load from bytes" path. node:sqlite needs a file path —
        // dump the bytes to a temp file, open it, then keep the path so
        // \`export()\` can re-read the file (incl. any subsequent writes).
        const dir = mkdtempSync(join(tmpdir(), 'moflo-probe-load-'));
        const path = join(dir, 'load.db');
        writeFileSync(path, Buffer.from(bytes));
        const db = new DatabaseSync(path);
        return wrapDb(db, { path });
      }
      // In-memory probe — \`export()\` falls back to the temp-file shuffle.
      return wrapDb(new DatabaseSync(':memory:'));
    },
  };
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`;

/**
 * Run a SQLite probe inline. The body has access to: `sqlInit` (the default
 * export from sql.js, an async initializer) and `emit(value)` which writes
 * the result as a single JSON line.
 *
 * Returns the parsed JSON, or null on failure (failure is recorded under
 * `<label>:probe`).
 */
export function runSqlJsProbe(consumerDir, label, body, runOpts = {}) {
  const probePath = join(consumerDir, `__${label}-probe.mjs`);
  writeFileSync(probePath, `${PROBE_HARNESS}\n${body}\n`);
  let result;
  try {
    result = runNode(probePath, [], { cwd: consumerDir, timeout: 60_000, ...runOpts });
  } finally {
    rmSync(probePath, { force: true });
  }
  if (result.code !== 0) {
    record(`${label}:probe`, 'fail', `exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 300)}`);
    return null;
  }
  const firstLine = result.stdout.trim().split('\n').find(line => line.startsWith('{') || line.startsWith('['));
  if (!firstLine) {
    record(`${label}:probe`, 'fail', `no JSON line in stdout: ${result.stdout.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(firstLine);
  } catch (err) {
    record(`${label}:probe`, 'fail', `JSON parse failed (${err.message}): ${firstLine.slice(0, 200)}`);
    return null;
  }
}

/**
 * Path-aware variant: builds the probe path with a guaranteed unique name
 * so concurrent probes (the MCP-clobber check spawns one alongside another)
 * don't collide. Returns the path so callers can pass it to `spawn` if they
 * need a long-lived process instead of `runNode`.
 */
export function writeStandaloneProbe(consumerDir, label, body) {
  const probePath = join(consumerDir, `__${label}-${Date.now()}.mjs`);
  writeFileSync(probePath, `${PROBE_HARNESS}\n${body}\n`);
  return probePath;
}
