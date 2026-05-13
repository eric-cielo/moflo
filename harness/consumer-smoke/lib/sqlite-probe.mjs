/**
 * Shared scaffolding for the populated-consumer harness's SQLite probe
 * subprocesses. Every probe writes a short `.mjs` script into the consumer
 * dir, runs it via `runNode`, parses the JSON its first stdout line emits,
 * and cleans up — this helper collapses that pattern.
 *
 * Engine is `node:sqlite` (Node ≥22; #1084 removed sql.js). The
 * PROBE_HARNESS preamble below still exposes a thin sql.js-shape adapter
 * (`sqlInit()` resolves to a `SQL` object with `Database`, `export()`,
 * statement API) so existing probe bodies continue to work without
 * per-call rewrites. File was named `sqljs-probe.mjs` prior to #1067 when
 * the sql.js shimming was dropped from the moflo runtime.
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
      // sql.js parity: serialise the whole DB as a Uint8Array. Three strategies
      // in priority order:
      //   1. node:sqlite's \`DatabaseSync.prototype.serialize()\` — added in
      //      Node v23.10. Returns Uint8Array directly. Node v22 (still the
      //      CI baseline) lacks it.
      //   2. File-backed probe — every Database() call (in-memory or load-
      //      from-bytes) is now backed by a temp file (see sqlInit below).
      //      Force a WAL checkpoint so any uncommitted pages flush to the
      //      main file, then read it.
      //   3. (Removed) The pre-#1067 fallback created an EMPTY DatabaseSync
      //      at a new path and read it back, returning 0 bytes — silently
      //      truncating every probe's export. That made the populated smoke
      //      flag "0 rows lost" failures on Node v22 (no serialize()).
      const ser = db.serialize?.();
      if (ser instanceof Uint8Array) return ser;
      if (ser && typeof ser === 'object' && 'buffer' in ser) return new Uint8Array(ser);
      if (!path) {
        throw new Error('export() requires a file-backed DatabaseSync — sqlInit() must always provide a path');
      }
      // Flush WAL pages back to the main file before readFileSync sees stale
      // bytes. \`PASSIVE\` returns immediately if another connection holds
      // a write transaction (none here — probes are single-process), and
      // \`TRUNCATE\` resets the WAL file. \`FULL\` is the strongest checkpoint
      // short of \`RESTART\` and is enough for the read-then-close sequence
      // probe bodies use.
      try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch { /* DELETE mode — no WAL */ }
      return new Uint8Array(readFileSync(path));
    },
    close: () => db.close(),
  };
}

// sql.js-shape factory. Probes call \`await sqlInit()\` then \`new SQL.Database()\`
// (fresh DB) or \`new SQL.Database(bytes)\` (open from bytes). BOTH forms now
// back the database with a temp file so \`export()\` always has somewhere
// reliable to read from on Node versions that lack \`DatabaseSync.serialize()\`.
async function sqlInit() {
  return {
    Database: function (bytes) {
      const dir = mkdtempSync(join(tmpdir(), 'moflo-probe-'));
      const path = join(dir, 'probe.db');
      if (bytes && bytes.length > 0) {
        // load-from-bytes path: drop the source bytes at \`path\` first, then
        // open. Subsequent writes mutate the same file so \`export()\` sees
        // both the original rows and any inserts.
        writeFileSync(path, Buffer.from(bytes));
      }
      // For the fresh-DB path, DatabaseSync creates the file on open. Force
      // DELETE journal mode so every commit syncs straight to the main file
      // — WAL mode would leave inserts in \`probe.db-wal\` and \`readFileSync\`
      // would dump a partial snapshot whose pages disagree with the WAL,
      // failing downstream \`PRAGMA integrity_check\` runs ("2nd reference to
      // page N", "Rowid out of order"). DELETE has no perf cost for these
      // single-process write-then-read fixtures.
      const db = new DatabaseSync(path);
      try { db.exec('PRAGMA journal_mode = DELETE'); } catch { /* probe still functional in WAL */ }
      return wrapDb(db, { path });
    },
  };
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`;

/**
 * Run a SQLite probe inline. The body has access to: `sqlInit` (an async
 * initializer returning a sql.js-shape `SQL` object, backed by `node:sqlite`)
 * and `emit(value)` which writes the result as a single JSON line.
 *
 * Returns the parsed JSON, or null on failure (failure is recorded under
 * `<label>:probe`).
 */
export function runSqliteProbe(consumerDir, label, body, runOpts = {}) {
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
