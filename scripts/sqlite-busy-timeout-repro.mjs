#!/usr/bin/env node
/**
 * Diagnostic repro for #1098.
 *
 * Question: does `node:sqlite` honor `PRAGMA busy_timeout` under multi-process
 * write contention? CI logs show 5–7 "database is locked" errors landing in
 * a single 5ms window with `busy_timeout=15000ms` configured — strong evidence
 * that the busy_handler is NOT engaging for the call pattern the bridge uses.
 *
 * Methodology:
 *   1. Parent process creates a fresh temp DB.
 *   2. Spawns CHILD A — opens DB, sets busy_timeout, runs BEGIN IMMEDIATE,
 *      sleeps `holdMs` (default 3000), COMMITs. Holds the write lock the
 *      whole time.
 *   3. After a small delay, spawns CHILD B — opens DB, sets busy_timeout,
 *      attempts to INSERT a row.
 *   4. Both children log their start/finish timestamps and any errors.
 *   5. Parent collates and reports.
 *
 * Expected behavior IF busy_timeout works:
 *   - Child B's INSERT blocks for ~3s, then succeeds.
 *   - Total wall-clock from B's start to B's INSERT-completed ≈ holdMs.
 *
 * Observed behavior IF busy_timeout is broken (the hypothesis):
 *   - Child B's INSERT fails immediately with "database is locked".
 *   - Total wall-clock from B's start to B's failure < 100ms.
 *
 * We test three call paths inside CHILD B because the failure mode might be
 * specific to one of:
 *   - `db.exec('INSERT ...')`
 *   - `db.prepare('INSERT ...').run(...)`
 *   - `stmt.all('SELECT ...')` on a contention boundary
 *
 * Run:
 *   node scripts/sqlite-busy-timeout-repro.mjs
 *   node scripts/sqlite-busy-timeout-repro.mjs --hold 5000 --busy 15000
 *
 * Output:
 *   JSON report on stdout with per-call-path verdict. Non-zero exit if any
 *   call path fails-fast (didn't retry up to busy_timeout).
 *
 * @module scripts/sqlite-busy-timeout-repro
 */

// Filter the once-per-process SQLite experimental warning so it doesn't
// pollute the diagnostic output (#1098).
{
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (msg.includes('SQLite is an experimental feature')) return;
    return orig.apply(this, [warning, ...args]);
  };
}

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);

// ─── Argument parsing ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { holdMs: 3000, busyMs: 15000, role: null, dbPath: null, callPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hold') out.holdMs = Number(argv[++i]);
    else if (a === '--busy') out.busyMs = Number(argv[++i]);
    else if (a === '--role') out.role = argv[++i];
    else if (a === '--db') out.dbPath = argv[++i];
    else if (a === '--call-path') out.callPath = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ─── Child A: hold the write lock for `holdMs` ──────────────────────────────
function childHolder() {
  const db = new DatabaseSync(args.dbPath);
  db.exec(`PRAGMA busy_timeout = ${args.busyMs}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  const startedAt = Date.now();
  process.stdout.write(`A:start ${startedAt}\n`);
  // BEGIN IMMEDIATE acquires RESERVED lock — blocks other writers but not readers.
  // For "database is locked" repro we need a writer-blocker; IMMEDIATE is correct.
  db.exec('BEGIN IMMEDIATE');
  db.exec(`INSERT INTO t (n) VALUES (1)`);
  // Synchronous sleep via Atomics.wait — no yielding to event loop so the
  // BEGIN IMMEDIATE write lock is unambiguously held for the duration.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, args.holdMs);
  db.exec('COMMIT');
  db.close();
  const finishedAt = Date.now();
  process.stdout.write(`A:finish ${finishedAt} held=${finishedAt - startedAt}ms\n`);
}

// ─── Child B: attempt a write while A holds the lock ────────────────────────
function childContender() {
  const db = new DatabaseSync(args.dbPath);
  db.exec(`PRAGMA busy_timeout = ${args.busyMs}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  const startedAt = Date.now();
  process.stdout.write(`B:start callPath=${args.callPath} ${startedAt}\n`);
  let error = null;
  try {
    if (args.callPath === 'exec') {
      db.exec('INSERT INTO t (n) VALUES (2)');
    } else if (args.callPath === 'prepare-run') {
      const stmt = db.prepare('INSERT INTO t (n) VALUES (?)');
      stmt.run(3);
    } else if (args.callPath === 'prepare-only') {
      // Prepare on a contended schema lock — surfaces whether prepare()
      // itself bypasses busy_handler.
      const stmt = db.prepare('INSERT INTO t (n) VALUES (?)');
      // Bind + run on a fresh statement so we measure prepare() in isolation
      // when contention is on schema. If prepare doesn't block, run might.
      stmt.run(4);
    } else if (args.callPath === 'begin') {
      // BEGIN IMMEDIATE on a contended writer — the classic "database is locked".
      db.exec('BEGIN IMMEDIATE');
      db.exec('INSERT INTO t (n) VALUES (5)');
      db.exec('COMMIT');
    } else if (args.callPath === 'deferred-upgrade') {
      // Deferred BEGIN + read + write — the SQLITE_BUSY_SNAPSHOT trap.
      // SQLite refuses to retry an upgrade from SHARED→RESERVED because
      // doing so could deadlock against another reader-trying-to-write.
      // busy_handler is NOT called; the second writer fails immediately
      // regardless of busy_timeout. This is the suspected #1098 trigger
      // for the bridge's mixed read/write withDb calls.
      db.exec('BEGIN'); // deferred — SHARED lock only
      db.prepare('SELECT COUNT(*) FROM t').all(); // upgrade attempt below
      db.exec('INSERT INTO t (n) VALUES (6)'); // ← read→write upgrade fails fast
      db.exec('COMMIT');
    } else {
      throw new Error(`Unknown call path: ${args.callPath}`);
    }
  } catch (err) {
    error = {
      message: err.message,
      code: err.code,
      stack: err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : null,
    };
  }
  db.close();
  const finishedAt = Date.now();
  const wallMs = finishedAt - startedAt;
  process.stdout.write(`B:finish callPath=${args.callPath} wallMs=${wallMs} error=${JSON.stringify(error)}\n`);
}

// ─── Parent: orchestrate ────────────────────────────────────────────────────
async function parent() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'moflo-busy-repro-'));
  const dbPath = join(tmpDir, 'repro.db');

  // Seed schema in the parent so both children only need to write.
  const seed = new DatabaseSync(dbPath);
  seed.exec(`PRAGMA busy_timeout = ${args.busyMs}`);
  seed.exec('PRAGMA journal_mode = WAL');
  seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
  seed.close();

  const results = [];

  for (const callPath of ['begin', 'prepare-run', 'exec', 'deferred-upgrade']) {
    // Fresh DB content per call-path so a stuck row doesn't bleed across cases.
    const aProc = spawn(process.execPath, [
      __filename, '--role', 'A',
      '--db', dbPath,
      '--hold', String(args.holdMs),
      '--busy', String(args.busyMs),
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    let aLog = '';
    aProc.stdout.on('data', (chunk) => { aLog += chunk.toString(); });

    // Give A a head start so its BEGIN IMMEDIATE is definitely in flight
    // before B attempts its write.
    await new Promise((r) => setTimeout(r, 250));

    const bStart = Date.now();
    const bProc = spawnSync(process.execPath, [
      __filename, '--role', 'B',
      '--db', dbPath,
      '--hold', String(args.holdMs),
      '--busy', String(args.busyMs),
      '--call-path', callPath,
    ], { encoding: 'utf-8' });
    const bWall = Date.now() - bStart;

    // Wait for A to finish so we can attach its log to the row.
    await new Promise((resolve) => {
      if (aProc.killed || aProc.exitCode != null) resolve();
      else aProc.once('exit', resolve);
    });

    const bLog = bProc.stdout || '';
    const errLine = bLog.split('\n').find((l) => l.startsWith('B:finish'));
    const errorMatch = errLine?.match(/error=({.*})$/);
    const error = errorMatch ? JSON.parse(errorMatch[1]) : null;
    const wallMatch = errLine?.match(/wallMs=(\d+)/);
    const reportedWall = wallMatch ? Number(wallMatch[1]) : null;

    // Verdict: if B's wall time < (holdMs - 500ms), busy_timeout didn't engage.
    const holdThreshold = args.holdMs - 500;
    const honored = reportedWall != null && reportedWall >= holdThreshold;

    results.push({
      callPath,
      bWallMs: reportedWall ?? bWall,
      bError: error,
      busyTimeoutHonored: honored,
      verdict: honored
        ? 'busy_timeout engaged — retried until A released the lock'
        : (error
            ? `failed-fast — busy_timeout did NOT engage for this call path (${error.message})`
            : 'completed but faster than expected — verify A actually held the lock'),
    });
  }

  rmSync(tmpDir, { recursive: true, force: true });

  const report = {
    platform: process.platform,
    nodeVersion: process.version,
    holdMs: args.holdMs,
    busyMs: args.busyMs,
    results,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  // Exit non-zero if any call path failed to honor busy_timeout — gives the
  // diagnostic a CI-friendly exit code without forcing the caller to parse JSON.
  const allHonored = results.every((r) => r.busyTimeoutHonored);
  process.exit(allHonored ? 0 : 1);
}

// ─── Entry point dispatch ───────────────────────────────────────────────────
if (args.role === 'A') {
  childHolder();
} else if (args.role === 'B') {
  childContender();
} else {
  parent().catch((err) => {
    console.error('repro parent crashed:', err);
    process.exit(2);
  });
}
