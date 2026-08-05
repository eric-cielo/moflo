/**
 * Per-step fingerprint gates for the session-start indexer chain.
 *
 * Background — issue #858: The 4.9.7 fix gated the ENTIRE chain on a single
 * global fingerprint. Two failure modes shipped with that:
 *
 *   1. Memory writes bump memory.db mtime → fingerprint invalidates → full
 *      chain re-runs (guidance, code-map, tests, patterns, pretrain, embeddings,
 *      HNSW) even though only build-embeddings and HNSW had actual work. The
 *      heavy steps cost minutes; this is the customer-visible CPU peg.
 *
 *   2. Source-file edits don't touch any global input → fingerprint matches →
 *      code-map skipped → consumer's codemap goes stale until something else
 *      bumps a global input.
 *
 * Per-step gates fix both: each step computes a fingerprint over inputs IT
 * cares about. Source edits trigger code-map but not guidance/embeddings.
 * Memory writes trigger embeddings/HNSW but not code-map/pretrain.
 *
 * Storage: a single `.moflo/index-step-fingerprints.json` keyed by step name.
 * Bumping FINGERPRINT_VERSION invalidates older payloads (graceful migration
 * — first session post-upgrade runs every step once, then steady state).
 *
 * Issue #1383 added a second, stronger signal for steps that can state their
 * own precondition exactly: a work probe (see STEP_WORK_PROBES). A fingerprint
 * answers "did the inputs change?"; a probe answers "is there work?". Where
 * both exist the probe wins, because the failure it prevents — skipping a step
 * that demonstrably had something to do — is silent and cumulative, while the
 * failure it risks is one cheap redundant run.
 *
 * Override: set `FLO_FORCE_INDEX=1` to bypass every gate (`flo doctor --fix`).
 *
 * Failure posture: any compute / read error returns null and forces the
 * step to run (safe fallback, never silently skip work).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MOFLO_DIR, mofloDir, memoryDbPath, hnswIndexPath } from './moflo-paths.mjs';
import { resolveGuidanceDirs } from './guidance-config.mjs';
import { hasPendingEmbeddings } from './embedding-backlog.mjs';

export const FINGERPRINT_FILE_NAME = 'index-step-fingerprints.json';
export const LEGACY_FINGERPRINT_FILE_NAME = 'index-all-fingerprint.json';
// Forward-slash relative paths kept as exports for tests + doctor / migration
// scripts that address the file by name.
export const FINGERPRINT_FILE_REL = `${MOFLO_DIR}/${FINGERPRINT_FILE_NAME}`;
export const LEGACY_FINGERPRINT_FILE_REL = `${MOFLO_DIR}/${LEGACY_FINGERPRINT_FILE_NAME}`;
export const FINGERPRINT_VERSION = 2;
export const FORCE_ENV = 'FLO_FORCE_INDEX';

function fingerprintFilePath(projectRoot) {
  return join(mofloDir(projectRoot), FINGERPRINT_FILE_NAME);
}

function legacyFingerprintFilePath(projectRoot) {
  return join(mofloDir(projectRoot), LEGACY_FINGERPRINT_FILE_NAME);
}

function safeMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Newest mtime across the SQLite file set — main DB plus its write-ahead log.
 *
 * `moflo.db` alone is not a change signal (#1383): under `journal_mode=WAL`
 * every row write lands in `moflo.db-wal` and the main file's mtime does not
 * move until a checkpoint folds the log back in. A gate stat'ing only the
 * main file therefore reports "unchanged" for writes that happened seconds
 * ago — which is how newly-indexed chunks got left unembedded.
 *
 * `-shm` is deliberately excluded: it is shared memory for the WAL index and
 * READERS touch it, so folding it in would invalidate the fingerprint on
 * sessions that only read the DB and re-run the step forever.
 */
function newestDbMtime(projectRoot) {
  const db = memoryDbPath(projectRoot);
  return Math.max(safeMtime(db), safeMtime(`${db}-wal`));
}

// Lockfiles across the common JS package managers. Any install/upgrade rewrites
// one of these, which is the signal the reference (library-docs) index gates on.
const LOCKFILE_NAMES = [
  'package-lock.json', 'npm-shrinkwrap.json',
  'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
];

function newestLockfileMtime(projectRoot) {
  let max = 0;
  for (const name of LOCKFILE_NAMES) {
    const m = safeMtime(resolve(projectRoot, name));
    if (m > max) max = m;
  }
  return max;
}

/**
 * Newest mtime across all files under `dir`, recursive. Skips dot-dirs and
 * `node_modules`/`dist` so the walk stays bounded. Depth-capped at 6.
 */
function newestMtimeRecursive(dir, depth = 6) {
  if (depth <= 0) return 0;
  let max = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const m = newestMtimeRecursive(full, depth - 1);
        if (m > max) max = m;
      } else if (entry.isFile()) {
        const m = safeMtime(full);
        if (m > max) max = m;
      }
    }
  } catch { /* unreadable — caller treats as 0 */ }
  return max;
}

// Per-process memo for `git ls-files` results. Multiple steps (code-map,
// patterns-index, pretrain) gate on the same SOURCE_GLOBS, and the orchestrator
// computes each fingerprint twice (pre-gate + post-run). Without the memo
// that's 6 git subprocess spawns per session over identical inputs.
const _gitListCache = new Map();

/**
 * Hash the file list returned by `git ls-files -s <patterns>`. Output includes
 * the git-recorded SHA-1 per file, so additions, removals, renames, and
 * content edits all change the byte stream. The intentional difference from
 * `incremental-write.computeContentListHash`: that one reads + hashes every
 * file (bytes-accurate ~50-200ms); this one delegates to git's index for
 * speed, since the per-step gate runs at session-start latency budget.
 *
 * Returns null when git is unavailable or cwd isn't a repo. Callers treat
 * null as "input changed" → forces a run (safe fallback).
 */
function gitFileListHash(projectRoot, patterns) {
  const cacheKey = `${projectRoot}\u0000${patterns.join('\u0000')}`;
  if (_gitListCache.has(cacheKey)) return _gitListCache.get(cacheKey);
  let hash = null;
  try {
    const raw = execFileSync('git', ['ls-files', '-s', '--', ...patterns], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch { /* null → safe fallback */ }
  _gitListCache.set(cacheKey, hash);
  return hash;
}

const SOURCE_GLOBS = [
  '*.ts', '*.tsx', '*.js', '*.mjs', '*.jsx', '*.cjs',
  '*.py', '*.pyi',
  '*.go',
  '*.java', '*.kt', '*.kts',
  '*.cs', '*.rs', '*.rb', '*.swift', '*.php',
  '*.c', '*.h', '*.cpp', '*.hpp', '*.cc',
];
const TEST_GLOBS = ['*.test.*', '*.spec.*', '*.test-*'];

/**
 * Newest mtime across every configured guidance directory (#1323).
 *
 * Folds with `Math.max` so adding a directory that happens to be older than the
 * current newest still can't lower the fingerprint. A missing directory yields
 * 0 from `newestMtimeRecursive`, so an unset/typo'd config entry degrades to
 * "contributes nothing" rather than throwing out of a session-start hook.
 */
function newestGuidanceMtime(projectRoot) {
  let newest = 0;
  for (const dir of resolveGuidanceDirs(projectRoot)) {
    const mtime = newestMtimeRecursive(resolve(projectRoot, dir));
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * Per-step fingerprint computers. Each takes `projectRoot` and returns a flat
 * `{ input → value }` object. All MUST be sync, cheap (no sql.js loads), and
 * call only into ls-files / stat. The orchestrator invokes the computer once
 * pre-gate and once post-run; the git-list cache absorbs the redundant work.
 */
const STEP_FINGERPRINT_COMPUTERS = {
  // Edits under ANY configured guidance directory, AND moflo upgrades (bundled
  // guidance ships with the package). Tracking node_modules/moflo/package.json
  // mtime catches upgrades without re-walking the bundled guidance tree.
  //
  // The directory list MUST come from the same resolver the indexer uses
  // (#1323). Fingerprinting a hardcoded `.claude/guidance` while the indexer
  // honoured `guidance.directories` meant every other configured directory was
  // indexed but never gated: edits there never invalidated the fingerprint, so
  // the guidance namespace served pre-edit content indefinitely — and since
  // embeddings regenerate from those same stale rows, text and vectors stayed
  // consistently wrong together with nothing downstream to detect it.
  'guidance-index': (projectRoot) => ({
    guidance: newestGuidanceMtime(projectRoot),
    mofloPkg: safeMtime(resolve(projectRoot, 'node_modules/moflo/package.json')),
  }),

  'code-map':       (projectRoot) => ({ sourceList: gitFileListHash(projectRoot, SOURCE_GLOBS) }),
  'test-index':     (projectRoot) => ({ testList:   gitFileListHash(projectRoot, TEST_GLOBS) }),
  'patterns-index': (projectRoot) => ({ sourceList: gitFileListHash(projectRoot, SOURCE_GLOBS) }),

  // Library-docs grounding (#1184). Re-index when installed dependency versions
  // change — which rewrites the lockfile (npm/yarn/pnpm/bun) — or when the dep
  // set in package.json is edited directly. mtime proxy, same cheap idiom as
  // build-embeddings; the indexer itself content-diffs so a spurious bump that
  // changed no docs is a near-no-op.
  'reference-index': (projectRoot) => ({
    lock: newestLockfileMtime(projectRoot),
    pkg: safeMtime(resolve(projectRoot, 'package.json')),
  }),

  'pretrain':       (projectRoot) => ({ sourceList: gitFileListHash(projectRoot, SOURCE_GLOBS) }),

  // The DB mtime is only a secondary signal here — the authoritative one is
  // the work probe below, which asks the database directly whether any row
  // still needs embedding. The fingerprint remains so the step still refreshes
  // its derived artifacts (vector-stats cache, sidecar) when the store changed
  // but the backlog is empty.
  //
  // `dbFiles` (not `memoryDb`) both names what is actually stat'd and
  // guarantees a mismatch against payloads written before #1383, so the first
  // session after upgrade re-runs these two steps once and settles.
  'build-embeddings': (projectRoot) => ({
    dbFiles: newestDbMtime(projectRoot),
  }),

  // HNSW sidecar must be at least as fresh as the store. Tracking both means:
  // sidecar deleted → mtime=0 → mismatch → run. Store written since the last
  // rebuild → mismatch → run. After a successful rebuild the saved pair
  // captures the post-rebuild equilibrium.
  //
  // This step shared #1383's WAL blind spot: embeddings written into the WAL
  // did not move `moflo.db`, so the sidecar was not resynced either and the
  // new vectors stayed unsearchable even once they existed. `newestDbMtime`
  // fixes both steps at once.
  //
  // The cost is that ANY write to the store now invalidates this step, so it
  // runs far more often — every session with memory activity, in practice.
  // That is affordable only because #1384 made the sidecar reconcile
  // incrementally instead of rebuilding: measured on a 5,310-vector store, a
  // no-change reconciliation is 0.07s versus 19.4s for the full rebuild this
  // step used to perform. This change MUST NOT ship ahead of that one.
  'hnsw-rebuild': (projectRoot) => ({
    dbFiles: newestDbMtime(projectRoot),
    sidecar: safeMtime(hnswIndexPath(projectRoot)),
  }),
};

/**
 * Per-step "is there work?" probes — the exact condition a step exists to
 * satisfy, asked of the real state rather than inferred from a file mtime.
 *
 * A probe returns `true` (work pending → run, no matter what the fingerprint
 * says), `false` (no backlog → the fingerprint decides, since the step still
 * refreshes derived artifacts), or `null` (unknowable → the fingerprint
 * decides). Steps with no probe are fingerprint-only.
 *
 * A probe may only ever FORCE a run, never suppress one. That asymmetry is
 * the point: an over-eager probe costs one cheap no-op run, whereas a probe
 * trusted to veto would resurrect #1383's silent skip the moment it was
 * wrong about the state.
 */
const STEP_WORK_PROBES = {
  'build-embeddings': hasPendingEmbeddings,
};

/**
 * Canonical ordered list of step names — derived from the computers map so
 * adding a step requires only one edit. `index-all.mjs` walks its plan in
 * this same order; the test asserts the array shape against an expected
 * literal so reordering either side surfaces immediately.
 */
export const STEP_NAMES = Object.freeze(Object.keys(STEP_FINGERPRINT_COMPUTERS));

export function computeStepFingerprint(stepName, projectRoot) {
  const fn = STEP_FINGERPRINT_COMPUTERS[stepName];
  if (!fn) throw new Error(`Unknown step name: ${stepName}`);
  return fn(projectRoot);
}

export function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function readFingerprintFile(projectRoot) {
  const path = fingerprintFilePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || data.version !== FINGERPRINT_VERSION) return null;
    return data.steps || null;
  } catch {
    return null;
  }
}

function writeFingerprintFile(projectRoot, allSteps) {
  const payload = {
    version: FINGERPRINT_VERSION,
    savedAt: new Date().toISOString(),
    steps: allSteps,
  };
  try {
    writeFileSync(fingerprintFilePath(projectRoot), JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function readSavedStepFingerprint(stepName, projectRoot) {
  const all = readFingerprintFile(projectRoot);
  if (!all) return null;
  return all[stepName] ?? null;
}

export function saveStepFingerprint(stepName, projectRoot, fp) {
  const all = readFingerprintFile(projectRoot) || {};
  all[stepName] = fp;
  return writeFingerprintFile(projectRoot, all);
}

/**
 * Ask a step's work probe whether it has pending work. Any throw is swallowed
 * to `null` — a gate must never be the thing that breaks session start.
 *
 * @returns {boolean | null}
 */
export function probeStepWork(stepName, projectRoot) {
  const probe = STEP_WORK_PROBES[stepName];
  if (!probe) return null;
  try {
    return probe(projectRoot);
  } catch {
    return null;
  }
}

/**
 * Decide whether `stepName` needs to run. Returns one of:
 *   { skip: true,  reason: 'unchanged' }
 *   { skip: false, reason: 'forced' | 'work-pending' | 'no-saved-fingerprint' | 'inputs-changed' }
 *
 * The orchestrator computes a POST-run fingerprint after each successful run
 * and saves THAT — not the pre-run one — so steps that mutate the inputs they
 * gate on (e.g. build-embeddings writing embeddings back) reach a stable
 * equilibrium on the next session.
 *
 * `work-pending` is checked before the fingerprint and is not overridable by
 * it (#1383). A step whose backlog is non-empty runs, full stop — the
 * fingerprint's job is deciding when to run a step that has *nothing* obvious
 * to do, and it is not allowed to answer a question the state answers exactly.
 */
export function decideStepGate(stepName, projectRoot, env = process.env) {
  if (env[FORCE_ENV]) {
    return { skip: false, reason: 'forced' };
  }
  const current = computeStepFingerprint(stepName, projectRoot);
  const saved = readSavedStepFingerprint(stepName, projectRoot);
  if (!saved) return { skip: false, reason: 'no-saved-fingerprint' };
  if (!fingerprintsEqual(current, saved)) return { skip: false, reason: 'inputs-changed' };

  // The fingerprint says skip. That is exactly — and only — where #1383 went
  // wrong, so this is where the state gets consulted. Probing last also keeps
  // it off the hot path: the query runs on quiet sessions, not on the ones
  // that were already going to do the work, and the fingerprint has been read
  // before the probe's read-only open materialises `-wal`/`-shm`, so the
  // probe cannot register its own side effect as an input change.
  if (probeStepWork(stepName, projectRoot) === true) {
    return { skip: false, reason: 'work-pending' };
  }
  return { skip: true, reason: 'unchanged' };
}

/**
 * Best-effort cleanup of the v1 single-fingerprint file from 4.9.7. Cheap
 * (one stat) so the orchestrator calls it unconditionally — leaving the file
 * to rot would otherwise survive every all-skip session indefinitely.
 */
export function cleanupLegacyFingerprint(projectRoot) {
  const legacy = legacyFingerprintFilePath(projectRoot);
  if (existsSync(legacy)) {
    try { unlinkSync(legacy); } catch { /* ignore — non-fatal */ }
  }
}

