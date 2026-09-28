/**
 * Populated-consumer check for #1495: a misfiled `verify:*` learning must be
 * healed in EVERY durable copy by the INSTALLED launcher, and stay healed.
 *
 * Before #1495 the local purge relocated the row, the shared-store seed wrote
 * it straight back, and the cleanup repeated every session. The unit tests
 * prove the rule against the source tree; this proves it from
 * `node_modules/moflo/` on all three CI platforms, which is the copy consumers
 * actually run (see `.claude/guidance/internal/dogfooding.md`).
 *
 * Seeds the local DB, a shared durable store (`MOFLO_DURABLE_PATH`, set only
 * for these launcher runs), and the team artifact; runs the launcher twice;
 * then runs the installed `flo memory team-export`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { flo } from './proc.mjs';
import { section, record, recordExit } from './report.mjs';
import { runSqliteProbe } from './sqlite-probe.mjs';
import { MOFLO_DIR, memoryDbPath } from '../../../bin/lib/moflo-paths.mjs';

const LOCAL_KEY = 'verify:smoke-1495-local';
const SHARED_KEY = 'verify:smoke-1495-shared';
const ARTIFACT_KEY = 'verify:smoke-1495-artifact';
const SHARED_LESSON = 'smoke-1495-shared-lesson';

/** Launcher lines that mean "healed something" — none may appear once converged. */
const HEAL_FRAGMENTS = [
  'refiled verify records',
  'dropped superseded verify records',
  'removed verify records from the shared store',
  'seeded shared learnings',
];

const V3_TABLE = `CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL, type TEXT DEFAULT 'semantic', embedding TEXT,
  embedding_model TEXT DEFAULT 'local', embedding_dimensions INTEGER, tags TEXT,
  metadata TEXT, owner_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  expires_at INTEGER, last_accessed_at INTEGER, access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
  UNIQUE(namespace, key))`;

/** Insert learnings rows into a DB file, creating the table when absent. */
function seedLearnings(consumerDir, label, dbPath, keys) {
  return runSqliteProbe(consumerDir, label, `
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec(${JSON.stringify(V3_TABLE)});
const now = Date.now();
const stmt = db.prepare("INSERT OR IGNORE INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) VALUES (?, ?, 'learnings', ?, ?, ?, 'active')");
for (const key of ${JSON.stringify(keys)}) stmt.run('smoke-' + key, key, 'content ' + key, now, now);
db.close();
emit({ seeded: ${keys.length} });
`);
}

/** Count misfiled rows (any status) and the rows the heal must preserve. */
function inspect(consumerDir, dbPath, sharedPath) {
  return runSqliteProbe(consumerDir, 'durable-heal-inspect', `
const count = (p, sql, ...args) => {
  const db = new DatabaseSync(p, { readOnly: true });
  try { return db.prepare(sql).get(...args).n; } finally { db.close(); }
};
const MISFILED = "SELECT COUNT(*) n FROM memory_entries WHERE namespace='learnings' AND key GLOB 'verify:*'";
emit({
  localMisfiled: count(${JSON.stringify(dbPath)}, MISFILED),
  sharedMisfiled: count(${JSON.stringify(sharedPath)}, MISFILED),
  localVerdictKept: count(${JSON.stringify(dbPath)}, "SELECT COUNT(*) n FROM memory_entries WHERE namespace='verify' AND key=?", ${JSON.stringify(LOCAL_KEY)}),
  sharedLessonSeeded: count(${JSON.stringify(dbPath)}, "SELECT COUNT(*) n FROM memory_entries WHERE namespace='learnings' AND status='active' AND key=?", ${JSON.stringify(SHARED_LESSON)}),
});
`);
}

function expectZero(label, value, what) {
  record(label, value === 0 ? 'pass' : 'fail', value === 0 ? undefined : `${value} ${what}`);
}

/**
 * @param {string} consumerDir
 * @param {(consumerDir: string, opts: { env: Record<string,string>, label: string }) => { stdout: string }} runLauncher
 */
export function runDurableHealCheck(consumerDir, runLauncher) {
  section('Populated: durable heal across stores (#1495)');

  const dbPath = memoryDbPath(consumerDir);
  const sharedDir = join(consumerDir, 'smoke-shared-durable');
  mkdirSync(sharedDir, { recursive: true });
  const sharedPath = join(sharedDir, 'durable.db');
  const artifactPath = join(consumerDir, MOFLO_DIR, 'shared', 'learnings.jsonl');

  if (!seedLearnings(consumerDir, 'durable-heal-seed-local', dbPath, [LOCAL_KEY])) return;
  if (!seedLearnings(consumerDir, 'durable-heal-seed-shared', sharedPath, [SHARED_KEY, SHARED_LESSON])) return;
  mkdirSync(join(consumerDir, MOFLO_DIR, 'shared'), { recursive: true });
  const provenance = { author: 'smoke', source: 'smoke', sharedAt: new Date().toISOString() };
  writeFileSync(
    artifactPath,
    [
      { namespace: 'learnings', key: ARTIFACT_KEY, content: 'x', type: 'semantic', updated_at: Date.now(), provenance },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  record('populated:durable-heal-seed', 'pass', 'local + shared store + team artifact each carry a verify:* learning');

  const env = { MOFLO_DURABLE_PATH: sharedPath };
  const first = runLauncher(consumerDir, { env, label: 'populated:durable-heal-launcher-1' });
  // Each heal path must visibly fire once, or the second run's "nothing
  // repeated" check would pass over a path that never ran at all.
  for (const fragment of ['refiled verify records', 'removed verify records from the shared store', 'seeded shared learnings']) {
    record(
      `populated:durable-heal-announce-${fragment.split(' ')[0]}`,
      first.stdout.includes(fragment) ? 'pass' : 'fail',
      first.stdout.includes(fragment) ? undefined : `first launcher stdout missing "${fragment}"`,
    );
  }

  const second = runLauncher(consumerDir, { env, label: 'populated:durable-heal-launcher-2' });
  const repeated = HEAL_FRAGMENTS.filter((f) => second.stdout.includes(f));
  record(
    'populated:durable-heal-converged',
    repeated.length === 0 ? 'pass' : 'fail',
    repeated.length === 0 ? undefined : `second launcher healed again: ${repeated.join(', ')}`,
  );

  const state = inspect(consumerDir, dbPath, sharedPath);
  if (state) {
    expectZero('populated:durable-heal-local-clean', state.localMisfiled, 'verify:* learnings left in the local DB');
    expectZero('populated:durable-heal-shared-clean', state.sharedMisfiled, 'verify:* learnings left in the shared store');
    record('populated:durable-heal-verdict-kept', state.localVerdictKept === 1 ? 'pass' : 'fail',
      state.localVerdictKept === 1 ? undefined : 'local verdict was not re-filed into the verify namespace');
    record('populated:durable-heal-real-lesson-seeded', state.sharedLessonSeeded === 1 ? 'pass' : 'fail',
      state.sharedLessonSeeded === 1 ? undefined : 'a real shared learning did not reach the local DB');
  }

  const exported = flo(consumerDir, ['memory', 'team-export'], { timeout: 60_000 });
  if (!recordExit('populated:durable-heal-team-export', exported)) return;
  const lines = existsSync(artifactPath)
    ? readFileSync(artifactPath, 'utf-8').split(/\r?\n/).filter((l) => l.trim())
    : [];
  const misfiledLines = lines.filter((l) => {
    try {
      const parsed = JSON.parse(l);
      return (parsed.deleted?.key ?? parsed.key ?? '').startsWith('verify:');
    } catch {
      return false;
    }
  });
  expectZero('populated:durable-heal-artifact-clean', misfiledLines.length, 'verify:* lines left in the team artifact');
}
