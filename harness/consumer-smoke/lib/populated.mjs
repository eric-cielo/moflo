/**
 * Populated-consumer smoke profile: proves a real-world consumer's stored
 * data survives a moflo upgrade. Safety gate for #727/#728/#729/#735.
 *
 * Pipeline: install moflo into a scratch consumer, seed `.swarm/memory.db`
 * + filesystem fixtures, invoke the session-start launcher, then assert the
 * post-state against hard-requirement invariants. A second pass exercises
 * the sql.js whole-DB clobber hazard (see feedback_sqljs_writeback_clobber).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';

import { runNode, flo, IS_WIN, recordSample } from './proc.mjs';
import { section, record, recordExit } from './report.mjs';
import { runSqlJsProbe, writeStandaloneProbe } from './sqljs-probe.mjs';
import {
  MOFLO_DIR,
  LEGACY_CLAUDE_FLOW_DIR,
  LEGACY_SWARM_DIR,
  MEMORY_DB_FILE,
  LEGACY_MEMORY_DB_FILE,
  LEGACY_MEMORY_DB_BAK_SUFFIX,
  HNSW_INDEX_FILE,
  memoryDbPath,
  legacyMemoryDbPath,
  legacyMemoryDbBakPath,
  hnswIndexPath,
  legacyHnswIndexPath,
} from '../../../bin/lib/moflo-paths.mjs';

const ACTIVE_NAMESPACES = ['guidance', 'patterns', 'code-map', 'tests', 'knowledge', 'learnings', 'default'];
const EPHEMERAL_NAMESPACES = ['hive-mind', 'tasklist', 'epic-state', 'test-bridge-fix'];
const ROWS_PER_ACTIVE_NAMESPACE = 20;
const ROWS_PER_EPHEMERAL_NAMESPACE = 5;
const ARCHIVED_ROW_COUNT = 3;
const DELETED_ROW_COUNT = 3;
const EMBEDDING_DIMS = 384;

const MODELS_FIXTURE_BYTES = Buffer.from('moflo-test-fake-binary');
const DATA_FIXTURE_JSON = JSON.stringify({ marker: 'foo', written: '2026-04-29' }, null, 2);
const AGENTS_FIXTURE_JSON = JSON.stringify({ agents: [{ id: 'fixture', role: 'noop' }] }, null, 2);
const DAEMON_STATE_FIXTURE_JSON = JSON.stringify({ pid: 0, startedAt: 0 }, null, 2);

const STALE_MODEL_PATH = `${LEGACY_CLAUDE_FLOW_DIR}/models/fixture.bin`;
const FIXTURE_FILENAME = 'fixture.bin';

function buildEmbedding(seed) {
  const arr = new Array(EMBEDDING_DIMS);
  let h = (seed >>> 0) || 1;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    arr[i] = ((h % 20000) - 10000) / 10000;
  }
  return JSON.stringify(arr);
}

function buildSeedPlan() {
  const rows = [];
  let seed = 1;

  for (const ns of ACTIVE_NAMESPACES) {
    for (let i = 0; i < ROWS_PER_ACTIVE_NAMESPACE; i++) {
      rows.push({
        id: `populated-${ns}-${i}`,
        key: `key-${ns}-${i}`,
        namespace: ns,
        content: `populated-consumer fixture row ${ns}/${i}`,
        status: 'active',
        embedding: buildEmbedding(seed++),
      });
    }
  }

  for (const ns of EPHEMERAL_NAMESPACES) {
    for (let i = 0; i < ROWS_PER_EPHEMERAL_NAMESPACE; i++) {
      rows.push({
        id: `ephemeral-${ns}-${i}`,
        key: `eph-${ns}-${i}`,
        namespace: ns,
        content: `ephemeral fixture row ${ns}/${i}`,
        status: 'active',
        embedding: null,
      });
    }
  }

  for (let i = 0; i < ARCHIVED_ROW_COUNT; i++) {
    rows.push({
      id: `archived-knowledge-${i}`,
      key: `archived-${i}`,
      namespace: 'knowledge',
      content: `archived fixture row ${i}`,
      status: 'archived',
      embedding: buildEmbedding(seed++),
    });
  }

  for (let i = 0; i < DELETED_ROW_COUNT; i++) {
    rows.push({
      id: `deleted-knowledge-${i}`,
      key: `deleted-${i}`,
      namespace: 'knowledge',
      content: `deleted fixture row ${i}`,
      status: 'deleted',
      embedding: buildEmbedding(seed++),
    });
  }

  return rows;
}

function seedSwarmDb(consumerDir, rows) {
  const swarmDir = join(consumerDir, LEGACY_SWARM_DIR);
  mkdirSync(swarmDir, { recursive: true });
  const dbPath = legacyMemoryDbPath(consumerDir);

  // Pre-#728 schema: status CHECK still permits 'deleted' so we can carry
  // soft-delete tombstones into the fixture for the launcher's purge to clean up.
  const result = runSqlJsProbe(consumerDir, 'seed-swarm-db', `
const SQL = await sqlInit();
const db = new SQL.Database();
db.exec(\`CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic',
  embedding TEXT,
  embedding_model TEXT DEFAULT 'local',
  embedding_dimensions INTEGER,
  tags TEXT,
  metadata TEXT,
  owner_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  expires_at INTEGER,
  last_accessed_at INTEGER,
  access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','archived','deleted')),
  UNIQUE(namespace, key)
)\`);
db.exec('CREATE INDEX idx_bridge_ns ON memory_entries(namespace)');
db.exec('CREATE INDEX idx_bridge_status ON memory_entries(status)');
const stmt = db.prepare('INSERT INTO memory_entries (id, key, namespace, content, embedding, embedding_dimensions, status) VALUES (?,?,?,?,?,?,?)');
const rows = ${JSON.stringify(rows)};
for (const r of rows) {
  stmt.run([r.id, r.key, r.namespace, r.content, r.embedding, r.embedding ? ${EMBEDDING_DIMS} : null, r.status]);
}
stmt.free();
const { writeFileSync } = await import('node:fs');
const buf = Buffer.from(db.export());
db.close();
writeFileSync(${JSON.stringify(dbPath)}, buf);
emit({ rows: rows.length, bytes: buf.length });
`);

  if (!result) throw new Error('seed db failed');
  record('populated:seed-db', 'pass', `${result.rows} rows / ${result.bytes} bytes`);
  return dbPath;
}

function seedFilesystemFixtures(consumerDir) {
  const claudeFlow = join(consumerDir, LEGACY_CLAUDE_FLOW_DIR);
  const swarmDir = join(consumerDir, LEGACY_SWARM_DIR);
  const moflo = join(consumerDir, MOFLO_DIR);

  mkdirSync(join(claudeFlow, 'models'), { recursive: true });
  mkdirSync(join(claudeFlow, 'data'), { recursive: true });
  mkdirSync(swarmDir, { recursive: true });
  mkdirSync(moflo, { recursive: true });

  writeFileSync(join(claudeFlow, 'models', FIXTURE_FILENAME), MODELS_FIXTURE_BYTES);
  writeFileSync(join(claudeFlow, 'data', 'foo.json'), DATA_FIXTURE_JSON);
  writeFileSync(join(claudeFlow, 'agents.json'), AGENTS_FIXTURE_JSON);
  writeFileSync(join(claudeFlow, 'daemon-state.json'), DAEMON_STATE_FIXTURE_JSON);

  // Non-empty hnsw sidecar so the relocation has something real to move.
  writeFileSync(legacyHnswIndexPath(consumerDir), Buffer.alloc(1024, 0x42));

  // Stale modelPath that section 0 of the launcher must rewrite once the
  // models/ subdir has been merged into .moflo/.
  writeFileSync(
    join(moflo, 'embeddings.json'),
    JSON.stringify({ modelPath: STALE_MODEL_PATH, model: 'fast-all-MiniLM-L6-v2' }, null, 2),
  );

  record('populated:seed-fs', 'pass', `${LEGACY_CLAUDE_FLOW_DIR} + ${LEGACY_SWARM_DIR} + ${MOFLO_DIR} fixtures placed`);
}

function runLauncher(consumerDir) {
  const launcher = join(consumerDir, 'node_modules', 'moflo', 'bin', 'session-start-launcher.mjs');
  if (!existsSync(launcher)) {
    record('populated:launcher-present', 'fail', `launcher missing at ${relative(consumerDir, launcher)}`);
    throw new Error('launcher missing');
  }
  const r = runNode(launcher, [], { cwd: consumerDir, timeout: 120_000 });
  if (!recordExit('populated:launcher-exit', r)) {
    throw new Error('launcher exited non-zero');
  }
  return r;
}

function inspectPostStateDb(consumerDir) {
  const dbPath = memoryDbPath(consumerDir);
  if (!existsSync(dbPath)) return null;

  return runSqlJsProbe(consumerDir, 'inspect-moflo-db', `
const { readFileSync } = await import('node:fs');
const SQL = await sqlInit();
const db = new SQL.Database(readFileSync(${JSON.stringify(dbPath)}));
const out = { byNamespaceStatus: {}, integrity: null, ids: [], hasEmbedding: 0 };
const res = db.exec("SELECT namespace, status, COUNT(*) FROM memory_entries GROUP BY namespace, status");
if (res[0]) {
  for (const row of res[0].values) out.byNamespaceStatus[row[0]+'/'+row[1]] = row[2];
}
const idsRes = db.exec("SELECT id FROM memory_entries");
if (idsRes[0]) out.ids = idsRes[0].values.map(r => r[0]);
const embRes = db.exec("SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL AND embedding != ''");
if (embRes[0]) out.hasEmbedding = embRes[0].values[0][0];
const intRes = db.exec("PRAGMA integrity_check");
if (intRes[0]) out.integrity = intRes[0].values[0][0];
db.close();
emit(out);
`);
}

function inspectInstalledEphemeralNamespaces(consumerDir) {
  const sourcePath = join(consumerDir, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'memory', 'bridge-embedder.js');
  if (!existsSync(sourcePath)) {
    record('populated:ephemeral-namespace-parity', 'fail', 'bridge-embedder.js missing in installed dist');
    return;
  }
  // Loading via dynamic import would also drag in fastembed transitives; a
  // text scan is sufficient because EPHEMERAL_NAMESPACES is a static literal.
  const source = readFileSync(sourcePath, 'utf8');
  const missing = EPHEMERAL_NAMESPACES.filter(ns => !source.includes(`'${ns}'`));
  if (missing.length === 0) {
    record('populated:ephemeral-namespace-parity', 'pass', `harness list matches installed dist`);
  } else {
    record('populated:ephemeral-namespace-parity', 'fail',
      `harness list drift — installed dist missing: ${missing.join(', ')} (update harness or check #729 regression)`);
  }
}

function assertActiveRowsPreserved(snapshot, expectedRows) {
  const expected = expectedRows.filter(r => r.status === 'active' && ACTIVE_NAMESPACES.includes(r.namespace));
  const presentIds = new Set(snapshot.ids);
  const missing = expected.filter(r => !presentIds.has(r.id));
  if (missing.length === 0) {
    record('populated:active-rows-preserved', 'pass', `${expected.length} rows survived migration`);
    return;
  }
  const sample = missing.slice(0, 3).map(r => r.id).join(', ');
  record(
    'populated:active-rows-preserved',
    'fail',
    `${missing.length} active row(s) lost — sample: ${sample}`,
  );
}

function assertArchivedRowsPreserved(snapshot) {
  const archivedCount = snapshot.byNamespaceStatus['knowledge/archived'] ?? 0;
  if (archivedCount >= ARCHIVED_ROW_COUNT) {
    record('populated:archived-preserved', 'pass', `${archivedCount} archived rows survive`);
  } else {
    record('populated:archived-preserved', 'fail', `expected ≥ ${ARCHIVED_ROW_COUNT} archived rows, got ${archivedCount}`);
  }
}

function assertDeletedRowsPurged(snapshot) {
  const deletedCount = snapshot.byNamespaceStatus['knowledge/deleted'] ?? 0;
  if (deletedCount === 0) {
    record('populated:deleted-purged', 'pass', 'no soft-deleted rows remain (#728)');
  } else {
    record('populated:deleted-purged', 'fail', `${deletedCount} status='deleted' rows leaked through #728 purge`);
  }
}

function assertEphemeralRowsPurged(snapshot) {
  const offenders = [];
  for (const ns of EPHEMERAL_NAMESPACES) {
    const active = snapshot.byNamespaceStatus[`${ns}/active`] ?? 0;
    if (active > 0) offenders.push(`${ns}=${active}`);
  }
  if (offenders.length === 0) {
    record('populated:ephemeral-purged', 'pass', 'no ephemeral-namespace rows remain (#729)');
  } else {
    record('populated:ephemeral-purged', 'fail', `ephemeral rows leaked through #729 purge: ${offenders.join(', ')}`);
  }
}

function assertIntegrity(snapshot) {
  if (snapshot.integrity === 'ok') {
    record('populated:db-integrity', 'pass', 'PRAGMA integrity_check ok');
  } else {
    record('populated:db-integrity', 'fail', `integrity_check = ${snapshot.integrity}`);
  }
}

function assertModelsRelocated(consumerDir) {
  const target = join(consumerDir, MOFLO_DIR, 'models', FIXTURE_FILENAME);
  const legacy = join(consumerDir, LEGACY_CLAUDE_FLOW_DIR, 'models', FIXTURE_FILENAME);
  const targetOk = existsSync(target) &&
    Buffer.compare(readFileSync(target), MODELS_FIXTURE_BYTES) === 0;
  if (!targetOk) {
    record('populated:models-relocated', 'fail', `${MOFLO_DIR}/models/${FIXTURE_FILENAME} missing or corrupted`);
    return;
  }
  if (existsSync(legacy)) {
    record('populated:models-relocated', 'fail', `${LEGACY_CLAUDE_FLOW_DIR}/models/${FIXTURE_FILENAME} still present after migration`);
    return;
  }
  record('populated:models-relocated', 'pass', `${LEGACY_CLAUDE_FLOW_DIR}/models → ${MOFLO_DIR}/models clean`);
}

function assertDataRelocated(consumerDir) {
  const target = join(consumerDir, MOFLO_DIR, 'data', 'foo.json');
  if (!existsSync(target) || readFileSync(target, 'utf8') !== DATA_FIXTURE_JSON) {
    record('populated:data-relocated', 'fail', `${MOFLO_DIR}/data/foo.json missing or corrupted`);
    return;
  }
  record('populated:data-relocated', 'pass', `${LEGACY_CLAUDE_FLOW_DIR}/data → ${MOFLO_DIR}/data clean`);
}

function assertEmbeddingsModelPathRewritten(consumerDir) {
  const cfg = join(consumerDir, MOFLO_DIR, 'embeddings.json');
  if (!existsSync(cfg)) {
    record('populated:embeddings-modelpath', 'fail', `${MOFLO_DIR}/embeddings.json missing post-launcher`);
    return;
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(cfg, 'utf8')); }
  catch (err) {
    record('populated:embeddings-modelpath', 'fail', `embeddings.json malformed: ${err.message}`);
    return;
  }
  if (typeof parsed.modelPath !== 'string') {
    record('populated:embeddings-modelpath', 'fail', 'modelPath missing or non-string');
    return;
  }
  if (parsed.modelPath.includes(LEGACY_CLAUDE_FLOW_DIR)) {
    record('populated:embeddings-modelpath', 'fail', `stale modelPath survived rewrite: ${parsed.modelPath}`);
    return;
  }
  record('populated:embeddings-modelpath', 'pass', `modelPath = ${parsed.modelPath}`);
}

function assertSwarmDbRetainedAsBak(consumerDir) {
  const live = legacyMemoryDbPath(consumerDir);
  const bak = legacyMemoryDbBakPath(consumerDir);
  const liveGone = !existsSync(live);
  const bakPresent = existsSync(bak) && statSync(bak).size > 0;
  if (liveGone && bakPresent) {
    record('populated:legacy-db-retained-as-bak', 'pass',
      `${LEGACY_SWARM_DIR}/${LEGACY_MEMORY_DB_FILE}${LEGACY_MEMORY_DB_BAK_SUFFIX} present, live file removed`);
  } else {
    const detail = `live=${liveGone ? 'gone' : 'PRESENT'} bak=${bakPresent ? 'OK' : 'MISSING'}`;
    record('populated:legacy-db-retained-as-bak', 'fail', detail);
  }
}

function assertHnswRelocated(consumerDir) {
  const hnsw = hnswIndexPath(consumerDir);
  if (!existsSync(hnsw)) {
    record('populated:hnsw-relocated', 'fail', `${MOFLO_DIR}/${HNSW_INDEX_FILE} missing`);
    return;
  }
  const size = statSync(hnsw).size;
  if (size === 0) {
    record('populated:hnsw-relocated', 'fail', `${MOFLO_DIR}/${HNSW_INDEX_FILE} is zero bytes`);
    return;
  }
  record('populated:hnsw-relocated', 'pass', `${MOFLO_DIR}/${HNSW_INDEX_FILE} = ${size} bytes`);
}

function assertLauncherAnnouncements(stdout) {
  const expected = [
    { fragment: 'migrated', label: 'announce-cf-migration' },
    { fragment: 'relocated memory db', label: 'announce-db-relocation' },
    { fragment: 'soft-deleted', label: 'announce-softdelete-purge' },
    { fragment: 'ephemeral namespace', label: 'announce-ephemeral-purge' },
  ];
  for (const e of expected) {
    if (stdout.includes(e.fragment)) {
      record(`populated:${e.label}`, 'pass');
    } else {
      record(`populated:${e.label}`, 'fail', `launcher stdout missing "${e.fragment}"`);
    }
  }
}

/**
 * Forcibly terminate a child process. On Windows, Node's `kill()` sends
 * SIGTERM which the child ignores — sql.js + a held mmap on `.swarm/memory.db`
 * leaves the file locked, blocking later cleanupWorkDir with EPERM. Use
 * taskkill /F /T (force, tree) on Windows; SIGKILL elsewhere.
 */
function forceKill(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      record('populated:force-kill', 'warn', `taskkill failed: ${err.message}`);
    }
  } else {
    try { child.kill('SIGKILL'); }
    catch (err) { record('populated:force-kill', 'warn', `SIGKILL failed: ${err.message}`); }
  }
}

/**
 * MCP-clobber regression check.
 *
 * The hazard from `feedback_sqljs_writeback_clobber.md`: a long-lived sql.js
 * process (MCP server, daemon) opens a memory DB, holds the whole snapshot
 * in RAM, and on every flush writes the entire file back.
 *
 * Test sequence:
 *   1. Long-lived opens legacy `.swarm/memory.db` and holds the snapshot.
 *   2. Launcher relocates legacy → `.moflo/moflo.db` and renames legacy → .bak.
 *   3. Long-lived flushes back to its original legacy path (the path it
 *      opened from — that's what sql.js's whole-file rewrite targets).
 *   4. Assert `.moflo/moflo.db` content matches what the launcher wrote.
 *      A regression where the launcher mutates the relocated DB via sql.js
 *      while a stale snapshot is in flight would surface as a byte mismatch.
 *
 * We deliberately target the legacy path instead of `.moflo/moflo.db`: on
 * Windows the launcher's background daemon/indexer holds `.moflo/moflo.db`
 * exclusively, so a direct writeFileSync there throws EBUSY and the test
 * becomes an OS-quirk gate rather than a launcher invariant gate.
 */
async function runMcpClobberCheck(consumerDir, seedRows) {
  section('Populated: MCP-clobber regression check');

  rmSync(join(consumerDir, MOFLO_DIR), { recursive: true, force: true });
  rmSync(legacyMemoryDbPath(consumerDir), { force: true });
  rmSync(legacyMemoryDbBakPath(consumerDir), { force: true });

  seedSwarmDb(consumerDir, seedRows);

  const markerPath = join(consumerDir, '__clobber-marker.log');
  rmSync(markerPath, { force: true });
  const longLivedPath = writeStandaloneProbe(consumerDir, 'mcp-clobber-longlived', `
const { readFileSync, writeFileSync, appendFileSync } = await import('node:fs');
const legacyPath = ${JSON.stringify(legacyMemoryDbPath(consumerDir))};
const markerPath = ${JSON.stringify(markerPath)};
function mark(stage) { try { appendFileSync(markerPath, stage + '\\n'); } catch {} }
mark('start');
try {
  const SQL = await sqlInit();
  mark('sqlinit');
  const buf = readFileSync(legacyPath);
  mark('read');
  const db = new SQL.Database(buf);
  mark('opened');
  process.stdout.write('LONG_LIVED_OPENED\\n');
  await new Promise(r => setTimeout(r, 4000));
  mark('woke');
  const out = Buffer.from(db.export());
  mark('exported');
  db.close();
  mark('closed');
  writeFileSync(legacyPath, out);
  mark('flushed');
  process.stdout.write('LONG_LIVED_FLUSHED\\n');
} catch (err) {
  mark('crash:' + (err.code || err.message));
  process.stdout.write('LONG_LIVED_WRITE_FAILED:' + (err.code || err.message) + '\\n');
}
`);

  const longLived = spawn(process.execPath, [longLivedPath], {
    cwd: consumerDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  longLived.stdout.on('data', d => { stdout += d.toString(); });
  longLived.stderr.on('data', d => { stderr += d.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('long-lived process never opened DB')), 30_000);
    longLived.stdout.on('data', () => {
      if (stdout.includes('LONG_LIVED_OPENED')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const launcher = join(consumerDir, 'node_modules', 'moflo', 'bin', 'session-start-launcher.mjs');
  const launcherResult = runNode(launcher, [], { cwd: consumerDir, timeout: 60_000 });
  recordExit('populated:clobber-launcher', launcherResult);

  // Quiesce the launcher's fire-and-forget daemon/indexer/pretrain tasks —
  // otherwise their concurrent writes to .moflo/moflo.db would race with the
  // long-lived flush and produce false-positive byte mismatches.
  flo(consumerDir, ['daemon', 'stop'], { timeout: 15_000 });

  const mofloDb = memoryDbPath(consumerDir);
  let postLauncherBytes;
  try { postLauncherBytes = readFileSync(mofloDb); }
  catch (err) {
    record('populated:clobber-mofloDb-untouched', 'fail',
      `${MOFLO_DIR}/${MEMORY_DB_FILE} unreadable post-launcher: ${err.message}`);
  }

  // 'close' fires after all stdio streams are drained — 'exit' fires when
  // the process terminates but stdout chunks may still be in flight. We need
  // every byte of stdout to land before reading `stdout` for assertions.
  await new Promise(resolve => {
    const timer = setTimeout(() => { forceKill(longLived); resolve(); }, 15_000);
    longLived.on('close', () => { clearTimeout(timer); resolve(); });
  });
  rmSync(longLivedPath, { force: true });
  rmSync(markerPath, { force: true });
  recordSample('mcp-clobber-longlived', stderr);

  if (!postLauncherBytes) return;

  let postFlushBytes;
  try { postFlushBytes = readFileSync(mofloDb); }
  catch (err) {
    record('populated:clobber-mofloDb-untouched', 'fail',
      `cannot reread ${MOFLO_DIR}/${MEMORY_DB_FILE}: ${err.message}`);
    return;
  }

  // The long-lived MUST have actually attempted its write — otherwise the
  // assertion is a no-op. Only the FLUSHED branch exercises the hazard.
  if (!stdout.includes('LONG_LIVED_FLUSHED')) {
    const exitCode = longLived.exitCode;
    const stderrTail = stderr ? `; stderr: ${stderr.trim().slice(0, 300)}` : '';
    let markerTail = '';
    try { markerTail = `; marker: ${readFileSync(markerPath, 'utf8').trim().replace(/\n/g, '|')}`; } catch { /* no marker */ }
    record('populated:clobber-mofloDb-untouched', 'fail',
      `long-lived never flushed (exit=${exitCode}; stdout: ${stdout.trim().slice(0, 200)}${stderrTail}${markerTail})`);
    return;
  }

  // The launcher's relocated file should be byte-stable. The long-lived's
  // legacy snapshot would have ~640KB of pre-#728 schema rows — if the
  // assertion ever flips, that snapshot has overwritten the launcher's
  // post-purge content.
  if (postLauncherBytes.equals(postFlushBytes)) {
    record('populated:clobber-mofloDb-untouched', 'pass',
      `${MOFLO_DIR}/${MEMORY_DB_FILE} unchanged after legacy-snapshot flush`);
  } else {
    record('populated:clobber-mofloDb-untouched', 'fail',
      `${MOFLO_DIR}/${MEMORY_DB_FILE} mutated by legacy flush (${postLauncherBytes.length} → ${postFlushBytes.length} bytes)`);
  }
}

export async function runPopulatedConsumerProfile(consumerDir) {
  inspectInstalledEphemeralNamespaces(consumerDir);

  section('Populated: pre-state seed');
  const rows = buildSeedPlan();
  seedSwarmDb(consumerDir, rows);
  seedFilesystemFixtures(consumerDir);

  section('Populated: launcher run');
  const launcherResult = runLauncher(consumerDir);

  section('Populated: doctor flush');
  const doctorResult = flo(consumerDir, ['doctor', '--json'], { timeout: 60_000 });
  recordExit('populated:doctor', doctorResult, { okCodes: [0, 1] });

  section('Populated: post-state assertions');
  const snapshot = inspectPostStateDb(consumerDir);
  if (!snapshot) {
    record('populated:post-state-snapshot', 'fail', `${MOFLO_DIR}/${MEMORY_DB_FILE} inspect probe failed`);
  } else {
    assertActiveRowsPreserved(snapshot, rows);
    assertArchivedRowsPreserved(snapshot);
    assertDeletedRowsPurged(snapshot);
    assertEphemeralRowsPurged(snapshot);
    assertIntegrity(snapshot);
  }
  assertModelsRelocated(consumerDir);
  assertDataRelocated(consumerDir);
  assertEmbeddingsModelPathRewritten(consumerDir);
  assertSwarmDbRetainedAsBak(consumerDir);
  assertHnswRelocated(consumerDir);
  assertLauncherAnnouncements(launcherResult.stdout);

  await runMcpClobberCheck(consumerDir, rows);
}
