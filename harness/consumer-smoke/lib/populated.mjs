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
import { spawn, execFileSync } from 'node:child_process';

import { runNode, flo, IS_WIN, recordSample } from './proc.mjs';
import { section, record, recordExit } from './report.mjs';
import { runSqliteProbe, writeStandaloneProbe } from './sqlite-probe.mjs';
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
import { MIGRATED_FROM_KNOWLEDGE } from '../../../bin/migrations/lib/markers.mjs';

/**
 * Kill every background process the launcher spawned so byte-stability
 * assertions don't race the indexer chain's `saveDb` writes. The launcher
 * tracks daemon + indexer PIDs in `.moflo/background-pids.json`; this
 * walks the registry and tree-kills each entry, then waits for them to
 * actually exit.
 *
 * Without this, `populated:active-rows-preserved` and
 * `populated:clobber-mofloDb-untouched` are timing flakes — the indexer's
 * orphan cleanup deletes seeded rows mid-assertion, and pretrain /
 * build-embeddings rewrite `.moflo/moflo.db` between the byte captures.
 */
function quiesceLauncherBackground(consumerDir) {
  const registry = join(consumerDir, MOFLO_DIR, 'background-pids.json');
  if (!existsSync(registry)) return 0;
  let entries;
  try { entries = JSON.parse(readFileSync(registry, 'utf8')); }
  catch { return 0; }
  if (!Array.isArray(entries)) return 0;

  let killed = 0;
  for (const entry of entries) {
    const pid = entry?.pid;
    if (typeof pid !== 'number' || pid <= 0) continue;
    try {
      if (IS_WIN) {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)],
          { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      } else {
        // detached:true at spawn → process group rooted at pid.
        try { process.kill(-pid, 'SIGKILL'); }
        catch { process.kill(pid, 'SIGKILL'); }
      }
      killed++;
    } catch { /* already gone */ }
  }
  // Empty the registry so the next launcher's spawns don't dedup against
  // dead entries and skip themselves.
  try { writeFileSync(registry, '[]'); } catch { /* non-fatal */ }
  return killed;
}

const ACTIVE_NAMESPACES = ['guidance', 'patterns', 'code-map', 'tests', 'knowledge', 'learnings', 'default'];
// Skip-embedding set (matches EPHEMERAL_NAMESPACES in src/cli/memory/bridge-embedder.ts).
const EPHEMERAL_NAMESPACES = ['hive-mind', 'tasklist', 'epic-state', 'test-bridge-fix'];
// Hard-purge set (matches PURGE_ON_SESSION_START_NAMESPACES). #968: tasklist
// is in EPHEMERAL_NAMESPACES (skip-embed) but NOT here — those rows back the
// dashboard Flo Runs tab and survive across session restarts.
const PURGED_NAMESPACES = ['hive-mind', 'epic-state', 'test-bridge-fix'];
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
  const result = runSqliteProbe(consumerDir, 'seed-swarm-db', `
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
// writeFileSync / readFileSync are provided by the probe harness now (#1098).
const buf = Buffer.from(db.export());
db.close();
writeFileSync(${JSON.stringify(dbPath)}, buf);
emit({ rows: rows.length, bytes: buf.length });
`);

  if (!result) throw new Error('seed db failed');
  record('populated:seed-db', 'pass', `${result.rows} rows / ${result.bytes} bytes`);
  return dbPath;
}

/**
 * Pre-populate `.moflo/moflo.db` with the `tasklist` rows the harness expects
 * to survive the launcher (#968 retention contract). SpellCaster.storeProgress
 * writes here in steady state, so to test the trim semantics we have to seed
 * THIS db — not `.swarm/memory.db`. The cherry-pick (`learnings`/`knowledge`
 * only) doesn't carry tasklist forward from legacy, by design.
 *
 * Schema-compatible with `MEMORY_SCHEMA_V3` for the columns the launcher's
 * trim query touches (id, key, namespace, content, status, created_at). The
 * cherry-pick's `CREATE TABLE IF NOT EXISTS` is a no-op when our table is
 * already there. Critically, the `status` CHECK constraint here matches V3
 * (only `'active'` and `'archived'` allowed) — NOT the legacy pre-#728
 * schema in `seedSwarmDb` which still permits `'deleted'`. If we used the
 * loose constraint, the cherry-pick would smuggle the harness's 3
 * deleted-knowledge rows into `.moflo/moflo.db` and `populated:announce-no-
 * legacy-purge-soft-deleted` would (correctly) fail on the resulting
 * §3e-728 cleanup banner.
 */
// #1053: legacy doc-* + chunk-with-preamble fixtures so the populated
// harness can prove the migrations actually do their work — not just
// vacuously pass against an empty fixture. purge-doc-entries should remove
// LEGACY_DOC_KEYS; strip-context-preambles should clean LEGACY_CHUNK_KEYS.
const LEGACY_DOC_KEYS = ['doc-guidance-legacy-foo', 'doc-guidance-legacy-bar'];
const LEGACY_CHUNK_KEYS = ['chunk-guidance-legacy-foo-0', 'chunk-guidance-legacy-foo-1'];
const LEGACY_PREAMBLE_CONTENT =
  '# Legacy Section\n\n[Context from previous section:]\nold prior text\n\n---\n\nreal chunk content\n\n---\n\n[Context from next section:]\nold next text';

function buildLegacyEpic1053Rows() {
  // Use a non-canonical namespace so the seed doesn't collide with the
  // cherry-pick assertion (assertDerivedRowsRegenerable expects 0 active
  // rows in `guidance` after launcher). The migrations purge/strip by KEY
  // prefix, namespace-agnostic — so this still exercises both migrations.
  const ns = 'epic-1053-fixture';
  const rows = [];
  for (const key of LEGACY_DOC_KEYS) {
    rows.push({ id: `legacy-${key}`, key, namespace: ns, content: 'legacy doc body', status: 'active' });
  }
  for (const key of LEGACY_CHUNK_KEYS) {
    rows.push({ id: `legacy-${key}`, key, namespace: ns, content: LEGACY_PREAMBLE_CONTENT, status: 'active' });
  }
  return rows;
}

function seedMofloDb(consumerDir, tasklistRows) {
  const mofloDir = join(consumerDir, MOFLO_DIR);
  mkdirSync(mofloDir, { recursive: true });
  const dbPath = memoryDbPath(consumerDir);

  // #1053: seed both tasklist (existing #968 retention test) and the legacy
  // doc-*/chunk-w-preamble fixtures the new migrations should clean up.
  const allRows = [...tasklistRows, ...buildLegacyEpic1053Rows()];

  const result = runSqliteProbe(consumerDir, 'seed-moflo-db', `
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
  status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
  UNIQUE(namespace, key)
)\`);
db.exec('CREATE INDEX idx_bridge_ns ON memory_entries(namespace)');
db.exec('CREATE INDEX idx_bridge_status ON memory_entries(status)');
const stmt = db.prepare('INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?,?,?,?,?)');
const rows = ${JSON.stringify(allRows)};
for (const r of rows) {
  stmt.run([r.id, r.key, r.namespace, r.content, r.status]);
}
stmt.free();
// writeFileSync / readFileSync are provided by the probe harness now (#1098).
const buf = Buffer.from(db.export());
db.close();
writeFileSync(${JSON.stringify(dbPath)}, buf);
emit({ rows: rows.length, bytes: buf.length });
`);

  if (!result) throw new Error('seed moflo db failed');
  record('populated:seed-moflo-db', 'pass',
    `${result.rows} rows / ${result.bytes} bytes (incl. ${LEGACY_DOC_KEYS.length} doc-* + ${LEGACY_CHUNK_KEYS.length} chunk-w-preamble)`);
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

  // Disable indexers so the seeded `key-<ns>-N` rows don't get pruned by
  // index-guidance.mjs's orphan cleanup (any `guidance` row whose key
  // doesn't match `doc-*` / `chunk-*` is treated as residue from a deleted
  // file and DELETE'd). Without this gate the populated profile is racing
  // the launcher's fire-and-forget indexer chain — the test passed on main
  // only because the chain hadn't reached its first saveDb by the time
  // inspect ran. moflo.yaml's `auto_index` flags are honoured by
  // bin/index-all.mjs and skip-spawn the four script-based indexers.
  writeFileSync(join(consumerDir, 'moflo.yaml'),
    [
      'auto_index:',
      '  guidance: false',
      '  code_map: false',
      '  tests: false',
      '  patterns: false',
      '',
    ].join('\n'),
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
  // Stop background tasks before any DB inspection. With `auto_index`
  // disabled in moflo.yaml the indexer steps skip-spawn, but pretrain /
  // build-embeddings / hnsw-rebuild still run sequentially after them and
  // write to `.moflo/moflo.db`; if those land between assertion captures
  // the byte-stability checks flap.
  quiesceLauncherBackground(consumerDir);
  return r;
}

function inspectPostStateDb(consumerDir) {
  const dbPath = memoryDbPath(consumerDir);
  if (!existsSync(dbPath)) return null;

  return runSqliteProbe(consumerDir, 'inspect-moflo-db', `
// readFileSync is provided by the probe harness (#1098).
//
// #1067: the launcher writes \`.moflo/moflo.db\` in WAL journal mode, so a
// raw \`readFileSync(dbPath)\` snapshot of the main file alone is inconsistent
// with the WAL-resident pending pages — opening those bytes in a fresh
// DatabaseSync flags PRAGMA integrity_check with duplicate-page refs
// ("Rowid out of order"). Open the live file briefly, force a TRUNCATE
// checkpoint to flush WAL → main, close, then readFileSync sees a coherent
// snapshot. (Pre-#1067 the seed wrote 0 bytes, the launcher rebuilt the DB
// from scratch in DELETE mode, and this hazard was hidden.)
{
  const { DatabaseSync: _Sync } = await import('node:sqlite');
  const _db = new _Sync(${JSON.stringify(dbPath)});
  try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* DELETE mode → no-op */ }
  _db.close();
}
const SQL = await sqlInit();
const db = new SQL.Database(readFileSync(${JSON.stringify(dbPath)}));
const out = { byNamespaceStatus: {}, integrity: null, ids: [], hasEmbedding: 0, migratedLearnings: { byStatus: {}, withEmbedding: 0, sampleKeys: [] }, epic1053: { docCount: 0, preambleChunkCount: 0 }, derivedSeedLeaks: {} };
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
const migMarker = ${JSON.stringify(`%${MIGRATED_FROM_KNOWLEDGE}%`)};
const migRes = db.exec("SELECT status, COUNT(*) FROM memory_entries WHERE namespace='learnings' AND tags LIKE '" + migMarker + "' GROUP BY status");
if (migRes[0]) {
  for (const row of migRes[0].values) out.migratedLearnings.byStatus[row[0]] = row[1];
}
const migEmbRes = db.exec("SELECT COUNT(*) FROM memory_entries WHERE namespace='learnings' AND tags LIKE '" + migMarker + "' AND embedding IS NOT NULL AND embedding != ''");
if (migEmbRes[0]) out.migratedLearnings.withEmbedding = migEmbRes[0].values[0][0];
const sampleRes = db.exec("SELECT key FROM memory_entries WHERE namespace='learnings' AND tags LIKE '" + migMarker + "' LIMIT 5");
if (sampleRes[0]) out.migratedLearnings.sampleKeys = sampleRes[0].values.map(r => r[0]);
// #1053 S4 + S5: doc-* purge + preamble strip results.
const docRes = db.exec("SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'doc-%'");
if (docRes[0]) out.epic1053.docCount = docRes[0].values[0][0];
const preambleRes = db.exec("SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'chunk-%' AND (content LIKE '%[Context from previous section:]%' OR content LIKE '%[Context from next section:]%')");
if (preambleRes[0]) out.epic1053.preambleChunkCount = preambleRes[0].values[0][0];
// #1067: derived-namespace cherry-pick leak detection — count ONLY rows
// whose ids carry the legacy seed prefix (\`populated-\${ns}-\${i}\`). The
// launcher's pretrain pipeline legitimately writes its OWN pattern-* keys
// into the patterns namespace post-upgrade (independent of auto_index),
// so a raw "patterns is non-empty" check was unsound. Cherry-pick leaks
// would surface as ids that match the seed pattern AND landed in
// .moflo/moflo.db.
const seedLeakRes = db.exec("SELECT substr(id, 11, instr(substr(id, 11), '-') - 1) AS ns, COUNT(*) FROM memory_entries WHERE id LIKE 'populated-%' AND namespace IN ('guidance','patterns','code-map','tests') GROUP BY ns");
if (seedLeakRes[0]) {
  for (const row of seedLeakRes[0].values) out.derivedSeedLeaks[row[0]] = row[1];
}
db.close();
emit(out);
`);
}

function assertEpic1053MigrationsFired(snapshot) {
  // Seed planted 2 doc-* + 2 chunk-with-preamble rows (see buildLegacyEpic1053Rows).
  // After the launcher fires the run-migrations chain, both should be 0.
  const docCount = snapshot.epic1053?.docCount ?? -1;
  const preambleCount = snapshot.epic1053?.preambleChunkCount ?? -1;
  if (docCount === 0 && preambleCount === 0) {
    record('populated:epic1053-migrations', 'pass',
      'doc-* purged + chunk preambles stripped (#1053 S4+S5)');
    return;
  }
  record('populated:epic1053-migrations', 'fail',
    `expected 0/0, got doc-*=${docCount}, preamble-chunks=${preambleCount} — migrations didn't fire or didn't clean (S4+S5)`);
}

function inspectInstalledEphemeralNamespaces(consumerDir) {
  const sourcePath = join(consumerDir, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'memory', 'bridge-embedder.js');
  if (!existsSync(sourcePath)) {
    record('populated:ephemeral-namespace-parity', 'fail', 'bridge-embedder.js missing in installed dist');
    return;
  }
  // Loading via dynamic import would also drag in fastembed transitives; a
  // text scan is sufficient because both namespace sets are static literals.
  const source = readFileSync(sourcePath, 'utf8');
  const missing = [
    ...EPHEMERAL_NAMESPACES.filter(ns => !source.includes(`'${ns}'`)),
    ...PURGED_NAMESPACES.filter(ns => !source.includes(`'${ns}'`)),
  ];
  if (missing.length === 0) {
    record('populated:ephemeral-namespace-parity', 'pass', `harness list matches installed dist`);
  } else {
    record('populated:ephemeral-namespace-parity', 'fail',
      `harness list drift — installed dist missing: ${missing.join(', ')} (update harness or check #729/#968 regression)`);
  }
}

function assertDurableRowsPreserved(snapshot, expectedRows) {
  // #851 cherry-pick carries forward only the user-authored namespaces.
  // Derived namespaces (guidance, patterns, code-map, tests, default) are
  // discarded on upgrade and rebuilt by the indexers — losing them on
  // purpose is the whole point of cherry-pick over byte-copy migration.
  // `knowledge` is also excluded here — #750's knowledge→learnings
  // migration hard-deletes them after copy; survival is asserted on the
  // `learnings` counterpart in assertKnowledgeMigratedToLearnings.
  const DURABLE_NAMESPACES = ['learnings'];
  const expected = expectedRows.filter(
    r => r.status === 'active' && DURABLE_NAMESPACES.includes(r.namespace),
  );
  const presentIds = new Set(snapshot.ids);
  const missing = expected.filter(r => !presentIds.has(r.id));
  if (missing.length === 0) {
    record('populated:durable-rows-preserved', 'pass',
      `${expected.length} learnings rows survived cherry-pick`);
    return;
  }
  const sample = missing.slice(0, 3).map(r => r.id).join(', ');
  record(
    'populated:durable-rows-preserved',
    'fail',
    `${missing.length} learnings row(s) lost — sample: ${sample}`,
  );
}

function assertDerivedRowsRegenerable(snapshot) {
  // #851 contract: derived namespaces (guidance, patterns, code-map, tests)
  // do NOT survive cherry-pick — they regenerate from indexers. moflo.yaml's
  // auto_index gate skip-spawns the four script-based indexers, but the
  // launcher's pretrain pipeline (NOT covered by auto_index) writes its own
  // `pattern-*` keys into the patterns namespace based on the consumer's
  // actual code surface. Those rows are legitimate post-upgrade output, not
  // a cherry-pick leak.
  //
  // Pre-#1067 this asserted "namespace count == 0" and was masked by a sql.js-
  // probe bug that left the seed DB empty: cherry-pick had nothing to copy,
  // pretrain wrote zero rows on an empty corpus, and the assertion saw 0.
  // Once the probe was fixed, pretrain produced its real output and the
  // assertion fired a false positive. Re-scope: assert ONLY that rows with
  // the legacy seed-key prefix (`populated-${ns}-${i}`) did NOT land in the
  // post-state DB. Those would be the actual cherry-pick leak signal.
  const DERIVED_NAMESPACES = ['guidance', 'patterns', 'code-map', 'tests'];
  const offenders = [];
  for (const ns of DERIVED_NAMESPACES) {
    const seedLeak = snapshot.derivedSeedLeaks?.[ns] ?? 0;
    if (seedLeak > 0) offenders.push(`${ns}=${seedLeak}`);
  }
  if (offenders.length === 0) {
    record('populated:derived-rows-not-cherry-picked', 'pass',
      'derived namespaces correctly excluded from cherry-pick');
  } else {
    record('populated:derived-rows-not-cherry-picked', 'fail',
      `derived namespaces leaked through cherry-pick (regression — #851 should be selective): ${offenders.join(', ')}`);
  }
}

function assertKnowledgePurged(snapshot) {
  // Story #750: every active+archived knowledge row should be hard-deleted
  // after the consolidation→purge migration pipeline.
  const offenders = [];
  for (const status of ['active', 'archived']) {
    const count = snapshot.byNamespaceStatus[`knowledge/${status}`] ?? 0;
    if (count > 0) offenders.push(`${status}=${count}`);
  }
  if (offenders.length === 0) {
    record('populated:knowledge-purged', 'pass', 'no legacy knowledge rows remain (#750)');
  } else {
    record('populated:knowledge-purged', 'fail', `legacy knowledge rows leaked through #750 purge: ${offenders.join(', ')}`);
  }
}

function assertKnowledgeMigratedToLearnings(snapshot) {
  // Every knowledge row should re-surface as a `learnings` row carrying the
  // `migratedFrom:knowledge` tag with status preserved (active stays active,
  // archived stays archived) and its embedding intact.
  const expectedActive = ROWS_PER_ACTIVE_NAMESPACE; // 20 from buildSeedPlan
  const expectedArchived = ARCHIVED_ROW_COUNT; // 3
  const expectedTotal = expectedActive + expectedArchived;
  const got = snapshot.migratedLearnings ?? { byStatus: {}, withEmbedding: 0, sampleKeys: [] };
  const gotActive = got.byStatus.active ?? 0;
  const gotArchived = got.byStatus.archived ?? 0;
  const gotTotal = gotActive + gotArchived;

  if (gotTotal < expectedTotal) {
    record('populated:knowledge-migrated', 'fail',
      `expected ≥ ${expectedTotal} migratedFrom:knowledge learnings rows, got ${gotTotal} (active=${gotActive}, archived=${gotArchived})`);
    return;
  }
  if (gotArchived < expectedArchived) {
    record('populated:knowledge-migrated', 'fail',
      `archived status not preserved on migrated rows: expected ≥ ${expectedArchived}, got ${gotArchived}`);
    return;
  }
  if (got.withEmbedding < expectedTotal) {
    record('populated:knowledge-migrated', 'fail',
      `embeddings dropped on migrated rows: ${got.withEmbedding}/${expectedTotal} retained`);
    return;
  }
  record('populated:knowledge-migrated', 'pass',
    `${gotTotal} learnings rows tagged migratedFrom:knowledge (active=${gotActive}, archived=${gotArchived}, with-embedding=${got.withEmbedding})`);
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
  for (const ns of PURGED_NAMESPACES) {
    const active = snapshot.byNamespaceStatus[`${ns}/active`] ?? 0;
    if (active > 0) offenders.push(`${ns}=${active}`);
  }
  if (offenders.length === 0) {
    record('populated:ephemeral-purged', 'pass', 'no purgeable namespace rows remain (#729)');
  } else {
    record('populated:ephemeral-purged', 'fail', `purgeable rows leaked through #729 purge: ${offenders.join(', ')}`);
  }

  // #968: tasklist is the dashboard's Flo Runs data source. The seeded rows
  // must SURVIVE the session-start launcher (it trims to retention cap, not
  // bulk-purges). With ROWS_PER_EPHEMERAL_NAMESPACE=5 well under the 200-row
  // cap, every seeded row is expected to remain.
  const tasklistActive = snapshot.byNamespaceStatus['tasklist/active'] ?? 0;
  if (tasklistActive >= ROWS_PER_EPHEMERAL_NAMESPACE) {
    record('populated:tasklist-retained', 'pass',
      `${tasklistActive} tasklist rows survived the launcher (#968 retention)`);
  } else {
    record('populated:tasklist-retained', 'fail',
      `expected ≥${ROWS_PER_EPHEMERAL_NAMESPACE} tasklist rows after launcher, got ${tasklistActive} (regression on #968 — Flo Runs tab will be empty)`);
  }
}

function assertIntegrity(snapshot) {
  if (snapshot.integrity === 'ok') {
    record('populated:db-integrity', 'pass', 'PRAGMA integrity_check ok');
  } else {
    record('populated:db-integrity', 'fail', `integrity_check = ${snapshot.integrity}`);
  }
}

// #851: legacy `.claude-flow/` and `.swarm/memory.db` are intentionally LEFT
// in place — never moved or renamed by the launcher. The harness now asserts
// the opposite of the pre-#851 contract: the legacy fixtures must survive
// untouched as recovery sources.
function assertModelsLeftInPlace(consumerDir) {
  const target = join(consumerDir, MOFLO_DIR, 'models', FIXTURE_FILENAME);
  const legacy = join(consumerDir, LEGACY_CLAUDE_FLOW_DIR, 'models', FIXTURE_FILENAME);
  const legacyOk = existsSync(legacy) &&
    Buffer.compare(readFileSync(legacy), MODELS_FIXTURE_BYTES) === 0;
  if (!legacyOk) {
    record('populated:models-left-in-place', 'fail',
      `${LEGACY_CLAUDE_FLOW_DIR}/models/${FIXTURE_FILENAME} missing or modified by launcher`);
    return;
  }
  if (existsSync(target)) {
    record('populated:models-left-in-place', 'fail',
      `${MOFLO_DIR}/models/${FIXTURE_FILENAME} present — launcher relocated it (regression: pre-#851 behavior)`);
    return;
  }
  record('populated:models-left-in-place', 'pass',
    `${LEGACY_CLAUDE_FLOW_DIR}/models/${FIXTURE_FILENAME} preserved`);
}

function assertDataLeftInPlace(consumerDir) {
  const legacy = join(consumerDir, LEGACY_CLAUDE_FLOW_DIR, 'data', 'foo.json');
  const target = join(consumerDir, MOFLO_DIR, 'data', 'foo.json');
  if (!existsSync(legacy) || readFileSync(legacy, 'utf8') !== DATA_FIXTURE_JSON) {
    record('populated:data-left-in-place', 'fail',
      `${LEGACY_CLAUDE_FLOW_DIR}/data/foo.json missing or modified`);
    return;
  }
  if (existsSync(target)) {
    record('populated:data-left-in-place', 'fail',
      `${MOFLO_DIR}/data/foo.json present — launcher relocated it (regression: pre-#851 behavior)`);
    return;
  }
  record('populated:data-left-in-place', 'pass',
    `${LEGACY_CLAUDE_FLOW_DIR}/data/foo.json preserved`);
}

function assertSwarmDbLeftInPlace(consumerDir) {
  const live = legacyMemoryDbPath(consumerDir);
  const bak = legacyMemoryDbBakPath(consumerDir);
  if (!existsSync(live)) {
    record('populated:legacy-db-left-in-place', 'fail',
      `${LEGACY_SWARM_DIR}/${LEGACY_MEMORY_DB_FILE} missing — launcher renamed/moved it (regression: pre-#851 behavior)`);
    return;
  }
  if (existsSync(bak)) {
    record('populated:legacy-db-left-in-place', 'fail',
      `${LEGACY_SWARM_DIR}/${LEGACY_MEMORY_DB_FILE}${LEGACY_MEMORY_DB_BAK_SUFFIX} present — launcher renamed source (regression: pre-#851 behavior)`);
    return;
  }
  record('populated:legacy-db-left-in-place', 'pass',
    `${LEGACY_SWARM_DIR}/${LEGACY_MEMORY_DB_FILE} preserved as recovery source`);
}

function assertCherryPickAnnouncement(stdout) {
  // Populated profile seeds `learnings` + `knowledge` rows in the legacy DB.
  // The launcher's #851 cherry-pick must announce its work so users can
  // distinguish a real upgrade from a silent run.
  if (stdout.includes('copied learnings forward')) {
    record('populated:announce-cherry-pick', 'pass');
  } else {
    record('populated:announce-cherry-pick', 'fail',
      `launcher stdout missing "copied learnings forward" — cherry-pick may not have fired`);
  }
}

function assertLauncherAnnouncements(stdout) {
  // The knowledge consolidation + legacy purge migrations run on `.moflo/moflo.db`
  // AFTER cherry-pick. Cherry-pick copies `learnings` + `knowledge` rows
  // forward, so those migrations have real work to announce on this profile.
  const expected = [
    { fragment: 'consolidated knowledge', label: 'announce-knowledge-consolidation' },
    { fragment: 'removed legacy knowledge', label: 'announce-knowledge-purge' },
  ];
  for (const e of expected) {
    if (stdout.includes(e.fragment)) {
      record(`populated:${e.label}`, 'pass');
    } else {
      record(`populated:${e.label}`, 'fail', `launcher stdout missing "${e.fragment}"`);
    }
  }

  // The soft-delete + ephemeral-namespace purges (#728 / #729) run on
  // `.moflo/moflo.db` too — but cherry-pick is selective, so neither
  // `status='deleted'` rows nor ephemeral namespaces ever reach the target
  // DB. Both purges correctly no-op for a fresh-install upgrade. The
  // post-state assertions (`populated:deleted-purged`,
  // `populated:ephemeral-purged`) confirm the rows are absent regardless;
  // we don't expect a stdout banner because there was nothing to clean.
  for (const fragment of ['soft-deleted', 'ephemeral namespace']) {
    if (stdout.includes(fragment)) {
      record(`populated:announce-no-legacy-purge-${fragment.replace(/\s+/g, '-')}`, 'fail',
        `launcher emitted "${fragment}" — derived rows leaked into .moflo/moflo.db so a purge had work, regression of cherry-pick selectivity`);
    } else {
      record(`populated:announce-no-legacy-purge-${fragment.replace(/\s+/g, '-')}`, 'pass');
    }
  }

  // Pre-#851 banners must NOT fire — they signal the byte-copy migration is back.
  for (const fragment of ['migrated', 'relocated memory db']) {
    if (stdout.split('\n').some((l) => l.startsWith('moflo:') && l.includes(fragment))) {
      record(`populated:announce-no-legacy-${fragment.replace(/\s+/g, '-')}`, 'fail',
        `launcher emitted pre-#851 "${fragment}" line — regression`);
    } else {
      record(`populated:announce-no-legacy-${fragment.replace(/\s+/g, '-')}`, 'pass');
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

  // Quiesce the prior phase's daemon + indexer chain before deleting
  // .moflo. On Windows the daemon holds moflo.db exclusively, so unlink
  // throws EBUSY and the harness aborts before any MCP-clobber assertion
  // runs (#1067). The launcher's second run leaves these processes alive
  // for the post-state probes — we own the cleanup.
  flo(consumerDir, ['daemon', 'stop'], { timeout: 15_000 });
  quiesceLauncherBackground(consumerDir);

  rmSync(join(consumerDir, MOFLO_DIR), { recursive: true, force: true });
  rmSync(legacyMemoryDbPath(consumerDir), { force: true });
  rmSync(legacyMemoryDbBakPath(consumerDir), { force: true });

  seedSwarmDb(consumerDir, seedRows);

  const markerPath = join(consumerDir, '__clobber-marker.log');
  rmSync(markerPath, { force: true });
  const longLivedPath = writeStandaloneProbe(consumerDir, 'mcp-clobber-longlived', `
// readFileSync / writeFileSync are provided by the probe harness (#1098).
// appendFileSync isn't in the harness baseline; import it on its own.
const { appendFileSync } = await import('node:fs');
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
  // `flo daemon stop` only kills the daemon process; the index-all chain
  // (pretrain → build-embeddings → hnsw-rebuild) is a separate process
  // tree, so we tree-kill everything in `.moflo/background-pids.json` too.
  flo(consumerDir, ['daemon', 'stop'], { timeout: 15_000 });
  quiesceLauncherBackground(consumerDir);

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
  // #968 trim semantics: SpellCaster writes tasklist into `.moflo/moflo.db`,
  // not the legacy `.swarm/memory.db`, so to test "tasklist survives the
  // launcher" we have to seed the canonical db directly. The launcher's
  // §3e-729 trim runs there and (with N=5 < 200 cap) keeps every row.
  const tasklistRows = rows.filter((r) => r.namespace === 'tasklist');
  seedMofloDb(consumerDir, tasklistRows);
  seedFilesystemFixtures(consumerDir);

  section('Populated: launcher run');
  const launcherResult = runLauncher(consumerDir);

  section('Populated: doctor flush');
  const doctorResult = flo(consumerDir, ['doctor', '--json'], { timeout: 60_000 });
  recordExit('populated:doctor', doctorResult, { okCodes: [0, 1] });

  // #1017: run the launcher a SECOND time before inspecting post-state. The
  // first launcher purges seed ephemerals, then doctor's hive-mind probe
  // intentionally writes a `msg:<id>` row to the hive-mind namespace as part
  // of exercising the spawn → bus → write-through path. The shutdown's
  // clearNamespace cleans most of these, but the multi-process race between
  // doctor's local sql.js writes and the launcher-spawned daemon's snapshot
  // (#981) means a row can occasionally survive within a single session.
  // The real-world contract is "ephemeral namespaces are purged at the
  // next session-start launcher" — this second run mirrors that contract.
  // The test still catches genuine purge regressions (any row that survives
  // two launcher runs would still be flagged), but no longer fails on the
  // intrinsic single-session race.
  section('Populated: second launcher (next-session purge)');
  runLauncher(consumerDir);

  section('Populated: post-state assertions');
  const snapshot = inspectPostStateDb(consumerDir);
  if (!snapshot) {
    record('populated:post-state-snapshot', 'fail', `${MOFLO_DIR}/${MEMORY_DB_FILE} inspect probe failed`);
  } else {
    assertDurableRowsPreserved(snapshot, rows);
    assertDerivedRowsRegenerable(snapshot);
    assertKnowledgePurged(snapshot);
    assertKnowledgeMigratedToLearnings(snapshot);
    assertDeletedRowsPurged(snapshot);
    assertEphemeralRowsPurged(snapshot);
    assertEpic1053MigrationsFired(snapshot);
    assertIntegrity(snapshot);
  }
  // #851: legacy state stays in place; launcher announces the cherry-pick.
  assertModelsLeftInPlace(consumerDir);
  assertDataLeftInPlace(consumerDir);
  assertSwarmDbLeftInPlace(consumerDir);
  assertCherryPickAnnouncement(launcherResult.stdout);
  assertLauncherAnnouncements(launcherResult.stdout);

  await runMcpClobberCheck(consumerDir, rows);
}
