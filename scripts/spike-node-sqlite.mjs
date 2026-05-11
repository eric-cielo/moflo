#!/usr/bin/env node
/**
 * Spike (issue #1079, epic #1078): validate node:sqlite parity against the
 * existing sql.js-backed moflo.db. THROWAWAY — no production code edits.
 *
 * Generates a fixture matrix at runtime from `.moflo/moflo.db`, opens each
 * fixture under BOTH sql.js and node:sqlite, runs a representative parity
 * battery, and asserts no row/byte divergence. Then runs a multi-process
 * clobber smoke (the structural reason the epic exists). Emits a structured
 * decision report — top-level `engineRecommendation` gates the rest of #1078.
 *
 * Usage:
 *   node scripts/spike-node-sqlite.mjs            # human report
 *   node scripts/spike-node-sqlite.mjs --json     # machine-readable JSON
 *   node scripts/spike-node-sqlite.mjs --fixture populated  # one fixture only
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const POPULATED_SRC = join(REPO_ROOT, '.moflo', 'moflo.db');

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fixtureArgIdx = args.indexOf('--fixture');
const onlyFixture = fixtureArgIdx >= 0 ? args[fixtureArgIdx + 1] : null;

// ---------------------------------------------------------------------------
// sql.js loader — mirrors src/cli/memory/sqljs-backend.ts:resolveSqlJsWasmDir
// so probe behavior matches the shipped path.
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
async function openSqlJs(dbPath) {
  const initSqlJs = (await import('sql.js')).default;
  let wasmDir = null;
  try {
    wasmDir = dirname(require.resolve('sql.js'));
  } catch { /* fallback to CDN */ }
  const SQL = await initSqlJs({
    locateFile: (f) => wasmDir ? join(wasmDir, f) : `https://sql.js.org/dist/${f}`,
  });
  if (existsSync(dbPath)) {
    return new SQL.Database(new Uint8Array(readFileSync(dbPath)));
  }
  return new SQL.Database();
}

// ---------------------------------------------------------------------------
// Fixture generation
// ---------------------------------------------------------------------------
const REPORT = {
  meta: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    populatedFixtureBytes: existsSync(POPULATED_SRC) ? statSync(POPULATED_SRC).size : 0,
    when: new Date().toISOString(),
  },
  fixtures: {},
  multiProcessClobber: null,
  engineRecommendation: 'unknown',
  blockingIssues: [],
};

function prepareFixtures(workDir) {
  const fixtures = {};

  // empty — fresh schema
  fixtures.empty = join(workDir, 'empty.db');
  {
    const db = new DatabaseSync(fixtures.empty);
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT, content TEXT,
        type TEXT, embedding TEXT, embedding_model TEXT, embedding_dimensions INTEGER,
        tags TEXT, metadata TEXT, owner_id TEXT,
        created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER, last_accessed_at INTEGER,
        access_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
        UNIQUE(namespace, key)
      );
      CREATE INDEX idx_memory_namespace ON memory_entries(namespace);
    `);
    db.close();
  }

  // populated — real-world copy
  if (existsSync(POPULATED_SRC)) {
    fixtures.populated = join(workDir, 'populated.db');
    copyFileSync(POPULATED_SRC, fixtures.populated);
  } else {
    REPORT.blockingIssues.push('No .moflo/moflo.db in repo to copy as populated fixture');
  }

  // mid-migration — populated + add a column (simulates schema migration in flight)
  if (fixtures.populated) {
    fixtures.midMigration = join(workDir, 'mid-migration.db');
    copyFileSync(fixtures.populated, fixtures.midMigration);
    const db = new DatabaseSync(fixtures.midMigration);
    // Mimic the kind of additive migration migration runners apply: new column.
    // Wrap in try because populated may already have it.
    try {
      db.exec('ALTER TABLE memory_entries ADD COLUMN spike_migration_marker TEXT');
    } catch { /* already applied — fine */ }
    db.close();
  }

  // post-cherry-pick — populated + a memory-healer-style delete/reinsert
  if (fixtures.populated) {
    fixtures.postCherryPick = join(workDir, 'post-cherry-pick.db');
    copyFileSync(fixtures.populated, fixtures.postCherryPick);
    const db = new DatabaseSync(fixtures.postCherryPick);
    const firstRow = db.prepare('SELECT id, key, namespace, content, type, embedding FROM memory_entries LIMIT 1').get();
    if (firstRow) {
      db.exec('BEGIN');
      db.prepare('DELETE FROM memory_entries WHERE id = ?').run(firstRow.id);
      db.prepare(`
        INSERT INTO memory_entries (id, key, namespace, content, type, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(firstRow.id, firstRow.key, firstRow.namespace, firstRow.content,
             firstRow.type, firstRow.embedding ?? null, Date.now(), Date.now());
      db.exec('COMMIT');
    }
    db.close();
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// Parity battery
// ---------------------------------------------------------------------------
function sqlJsAll(db, sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function normalizeValue(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Buffer.isBuffer(v)) return v.toString('base64');
  return v;
}

function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row).sort()) out[k] = normalizeValue(row[k]);
  return out;
}

function compareRowSets(label, sqlJsRows, nodeRows) {
  const issues = [];
  if (sqlJsRows.length !== nodeRows.length) {
    issues.push(`${label}: row count differs (sql.js=${sqlJsRows.length}, node:sqlite=${nodeRows.length})`);
    return { ok: false, issues, count: { sqlJs: sqlJsRows.length, node: nodeRows.length } };
  }
  const sJson = sqlJsRows.map(normalizeRow);
  const nJson = nodeRows.map(normalizeRow);
  for (let i = 0; i < sJson.length; i++) {
    const a = JSON.stringify(sJson[i]);
    const b = JSON.stringify(nJson[i]);
    if (a !== b) {
      issues.push(`${label}: row[${i}] diverges (first 200 chars):\n  sql.js: ${a.slice(0, 200)}\n  node:   ${b.slice(0, 200)}`);
      if (issues.length >= 3) break;
    }
  }
  return { ok: issues.length === 0, issues, count: { sqlJs: sqlJsRows.length, node: nodeRows.length } };
}

async function runBattery(label, fixturePath) {
  const result = {
    fixturePath,
    sizeBytes: statSync(fixturePath).size,
    checks: {},
    ok: true,
  };

  const sqlJsDb = await openSqlJs(fixturePath);
  const nodeDb = new DatabaseSync(fixturePath, { readOnly: true });
  try {
    // sqlite_master row-equality (schema parity)
    {
      const s = sqlJsAll(sqlJsDb, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
      const n = nodeDb.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
      result.checks.schema = compareRowSets('sqlite_master', s, n);
    }

    // Table contents — only check tables that exist (empty fixture has only one)
    const tables = nodeDb.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name IN ('memory_entries','patterns','trajectories','sessions','metadata','vector_indexes')
      ORDER BY name
    `).all().map(r => r.name);

    for (const t of tables) {
      // Cap at 5k rows per table to keep the battery bounded on the 30 MB populated fixture.
      const sql = `SELECT * FROM "${t}" ORDER BY rowid LIMIT 5000`;
      const s = sqlJsAll(sqlJsDb, sql);
      const n = nodeDb.prepare(sql).all();
      result.checks[`table:${t}`] = compareRowSets(t, s, n);
    }

    // Embedding parity — pull a sample of non-null embeddings (works for both TEXT JSON and BLOB)
    if (tables.includes('memory_entries')) {
      const sql = 'SELECT id, embedding FROM memory_entries WHERE embedding IS NOT NULL LIMIT 100';
      const s = sqlJsAll(sqlJsDb, sql);
      const n = nodeDb.prepare(sql).all();
      result.checks['embedding-sample'] = compareRowSets('embeddings', s, n);
    }

    // Roll up
    for (const c of Object.values(result.checks)) {
      if (!c.ok) result.ok = false;
    }
  } finally {
    sqlJsDb.close();
    nodeDb.close();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Write-path smokes (node:sqlite only — sql.js is read-side for parity above)
// ---------------------------------------------------------------------------
function testInsertOrReplace(populatedCopy) {
  const db = new DatabaseSync(populatedCopy);
  const id = `spike-${randomUUID()}`;
  const now = Date.now();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO memory_entries
        (id, key, namespace, content, type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'spike-key', 'spike-ns', 'spike-content-v1', 'semantic', now, now);
    // Re-INSERT with same id (OR REPLACE semantics)
    db.prepare(`
      INSERT OR REPLACE INTO memory_entries
        (id, key, namespace, content, type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'spike-key', 'spike-ns', 'spike-content-v2', 'semantic', now, now);
    const row = db.prepare('SELECT content FROM memory_entries WHERE id = ?').get(id);
    return { ok: row?.content === 'spike-content-v2', got: row?.content };
  } finally {
    db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    db.close();
  }
}

function testTransactions(populatedCopy) {
  const db = new DatabaseSync(populatedCopy);
  const commitId = `spike-commit-${randomUUID()}`;
  const rollbackId = `spike-rollback-${randomUUID()}`;
  try {
    // COMMIT visibility
    db.exec('BEGIN');
    db.prepare('INSERT INTO memory_entries (id, key, namespace, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      commitId, commitId, 'spike-tx', 'committed', 'semantic', Date.now(), Date.now()
    );
    db.exec('COMMIT');
    const committed = db.prepare('SELECT id FROM memory_entries WHERE id = ?').get(commitId);

    // ROLLBACK isolation
    db.exec('BEGIN');
    db.prepare('INSERT INTO memory_entries (id, key, namespace, content, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      rollbackId, rollbackId, 'spike-tx', 'rolled-back', 'semantic', Date.now(), Date.now()
    );
    db.exec('ROLLBACK');
    const rolled = db.prepare('SELECT id FROM memory_entries WHERE id = ?').get(rollbackId);

    return {
      ok: !!committed && !rolled,
      committedVisible: !!committed,
      rollbackHidden: !rolled,
    };
  } finally {
    db.prepare('DELETE FROM memory_entries WHERE id = ?').run(commitId);
    db.close();
  }
}

function testWalMode(workDir) {
  const dbPath = join(workDir, 'wal-test.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const mode = db.prepare('PRAGMA journal_mode').get();
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t (x) VALUES (?)').run(1);
    const walExists = existsSync(`${dbPath}-wal`);
    const shmExists = existsSync(`${dbPath}-shm`);
    return {
      ok: mode?.journal_mode === 'wal' && walExists && shmExists,
      mode: mode?.journal_mode,
      walSidecar: walExists,
      shmSidecar: shmExists,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Multi-process clobber smoke — the headline experiment.
// ---------------------------------------------------------------------------
const CHILD_WRITER = `
import { DatabaseSync } from 'node:sqlite';
const [dbPath, id, content, delayMs] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
// Stagger to maximize the overlap window.
await new Promise(r => setTimeout(r, Number(delayMs)));
db.prepare(\`
  INSERT OR REPLACE INTO memory_entries (id, key, namespace, content, type, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
\`).run(id, id, 'spike-mp', content, 'semantic', Date.now(), Date.now());
db.close();
process.stdout.write(JSON.stringify({ ok: true, id }));
`;

function spawnWriter(scriptPath, dbPath, id, content, delayMs) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [scriptPath, dbPath, id, content, String(delayMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => {
      if (code !== 0) rejectP(new Error(`writer ${id} exited ${code}: ${stderr || stdout}`));
      else resolveP({ id, stdout });
    });
  });
}

async function multiProcessClobberSmoke(workDir, populatedSrc) {
  const dbPath = join(workDir, 'multiproc.db');
  copyFileSync(populatedSrc, dbPath);
  // Promote to WAL once before children open it (so first-child contention
  // doesn't race with WAL-init itself).
  {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.close();
  }

  const scriptPath = join(workDir, 'child-writer.mjs');
  writeFileSync(scriptPath, CHILD_WRITER);

  // Distinct-rows clobber: the structural sql.js failure mode — two processes
  // each hold their own whole-file snapshot, so whichever flushes last wipes
  // the other's row even though there's no key contention.
  const id1 = `mp-${randomBytes(6).toString('hex')}-A`;
  const id2 = `mp-${randomBytes(6).toString('hex')}-B`;
  await Promise.all([
    spawnWriter(scriptPath, dbPath, id1, 'content-A', 50),
    spawnWriter(scriptPath, dbPath, id2, 'content-B', 0),
  ]);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const a = db.prepare('SELECT content FROM memory_entries WHERE id = ?').get(id1);
  const b = db.prepare('SELECT content FROM memory_entries WHERE id = ?').get(id2);
  db.close();

  // Same-key serialization: two processes INSERT OR REPLACE the same id with
  // different content. WAL must serialize — final content equals exactly one
  // of the two writes, never null/garbage.
  const sharedId = `mp-${randomBytes(6).toString('hex')}-SHARED`;
  await Promise.all([
    spawnWriter(scriptPath, dbPath, sharedId, 'content-X', 30),
    spawnWriter(scriptPath, dbPath, sharedId, 'content-Y', 0),
  ]);
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  const shared = db2.prepare('SELECT content FROM memory_entries WHERE id = ?').get(sharedId);
  db2.close();
  const sharedOk = shared?.content === 'content-X' || shared?.content === 'content-Y';

  return {
    ok: a?.content === 'content-A' && b?.content === 'content-B' && sharedOk,
    distinctRows: { rowA: a?.content ?? null, rowB: b?.content ?? null },
    sameKeySerialization: { winner: shared?.content ?? null, ok: sharedOk },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'moflo-spike-1079-'));
  try {
    const fixtures = prepareFixtures(workDir);

    const entries = Object.entries(fixtures).filter(([k]) => !onlyFixture || k === onlyFixture);
    for (const [name, path] of entries) {
      REPORT.fixtures[name] = await runBattery(name, path);
    }

    if (fixtures.populated) {
      const copy = join(workDir, 'write-smoke.db');
      copyFileSync(fixtures.populated, copy);
      REPORT.writeSmokes = {
        insertOrReplace: testInsertOrReplace(copy),
        transactions: testTransactions(copy),
        walMode: testWalMode(workDir),
      };
      REPORT.multiProcessClobber = await multiProcessClobberSmoke(workDir, fixtures.populated);
    }

    // Decision
    const allFixturesOk = Object.values(REPORT.fixtures).every(f => f.ok);
    const writeSmokesOk = REPORT.writeSmokes && Object.values(REPORT.writeSmokes).every(s => s.ok);
    const mpOk = REPORT.multiProcessClobber?.ok;
    if (REPORT.blockingIssues.length > 0) {
      REPORT.engineRecommendation = 'blocked';
    } else if (allFixturesOk && writeSmokesOk && mpOk) {
      REPORT.engineRecommendation = 'node-sqlite';
    } else {
      REPORT.engineRecommendation = 'better-sqlite3';
      if (!allFixturesOk) REPORT.blockingIssues.push('Parity battery failed on at least one fixture');
      if (!writeSmokesOk) REPORT.blockingIssues.push('Write-path smoke failed');
      if (!mpOk) REPORT.blockingIssues.push('Multi-process clobber smoke failed');
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(REPORT, null, 2) + '\n');
  } else {
    printHuman(REPORT);
  }
  process.exit(REPORT.engineRecommendation === 'node-sqlite' ? 0 : 1);
}

function printHuman(r) {
  const line = (s = '') => process.stdout.write(s + '\n');
  line('━━━ moflo.db spike (issue #1079, epic #1078) ━━━');
  line(`node ${r.meta.node} · ${r.meta.platform}/${r.meta.arch}`);
  line(`populated fixture: ${(r.meta.populatedFixtureBytes / 1024 / 1024).toFixed(1)} MB`);
  line('');
  line('── parity battery ──');
  for (const [name, f] of Object.entries(r.fixtures)) {
    line(`  ${f.ok ? 'PASS' : 'FAIL'}  ${name}  (${(f.sizeBytes / 1024).toFixed(0)} KB)`);
    for (const [check, res] of Object.entries(f.checks)) {
      const mark = res.ok ? '   ✓' : '   ✗';
      line(`${mark} ${check}  (sql.js=${res.count.sqlJs}, node=${res.count.node})`);
      for (const issue of res.issues.slice(0, 2)) line(`        ${issue}`);
    }
  }
  if (r.writeSmokes) {
    line('');
    line('── write-path smokes (node:sqlite) ──');
    for (const [k, v] of Object.entries(r.writeSmokes)) {
      line(`  ${v.ok ? 'PASS' : 'FAIL'}  ${k}  ${JSON.stringify({ ...v, ok: undefined })}`);
    }
  }
  if (r.multiProcessClobber) {
    line('');
    line('── multi-process clobber smoke ──');
    const m = r.multiProcessClobber;
    line(`  ${m.ok ? 'PASS' : 'FAIL'}  distinct=${JSON.stringify(m.distinctRows)} sameKey=${JSON.stringify(m.sameKeySerialization)}`);
  }
  line('');
  line(`DECISION: ${r.engineRecommendation}`);
  if (r.blockingIssues.length > 0) {
    line('blocking issues:');
    for (const b of r.blockingIssues) line(`  • ${b}`);
  }
}

main().catch((err) => {
  process.stderr.write(`spike failed: ${err.stack || err.message}\n`);
  process.exit(2);
});
