/**
 * Smoke-harness checks. Each check records pass/fail/warn/info via the
 * reporter; none throw on a soft fail. Abort-on-hard-error (pack/install
 * prerequisites) is handled by the caller via re-thrown errors.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';

import { run, runNode, flo, NPM_CMD, getStderrSamples } from './proc.mjs';
import { section, record, recordExit, log } from './report.mjs';
import { findOrphans } from '../../../scripts/clean-dist.mjs';
import { findOrtPackages, listNapiDirs } from '../../../scripts/prune-native-binaries.mjs';

// Epic #501 acceptance criterion: a fresh `npm install moflo` consumer sees
// zero of the following packages anywhere in its dep tree.
// Epic #527 (story #532) extended this list with `@xenova/transformers` —
// the archived transformers runtime replaced by `fastembed`.
//
// Note: `onnxruntime-node` is required since #613 — moflo declares it directly
// (replacing the upstream `fastembed` pin that crashed on macOS at process exit
// per microsoft/onnxruntime#24579). Its binaries are pruned by the postinstall
// script. `fastembed` itself is now FORBIDDEN: any consumer install that pulls
// it back in has regressed and would re-introduce the pinned ORT 1.21.0.
export const FORBIDDEN_DEPS = [
  'agentdb',
  'agentic-flow',
  '@ruvector',
  'ruvector',
  '@xenova/transformers',
  'fastembed',
];

// Dependencies that MUST be present in a fresh consumer install. Missing
// `onnxruntime-node` or `@anush008/tokenizers` means the embedding stack is
// broken — hash-fallback is no longer permitted (epic #527 story #532).
export const REQUIRED_DEPS = [
  'onnxruntime-node',
  '@anush008/tokenizers',
];

// Epic #527 (story #532): banned identifiers that must not appear anywhere
// in the published dist tree. If any of these leak through into compiled
// output, hash-fallback code has crept back in.
//
// Issue #545 extended the list with `hashEmbed` + `embedWithFallback` — the
// actual live call-sites deleted in PR #557. `generateEmbedding` is
// deliberately omitted because it is the legitimate public fastembed API
// re-exported by @moflo/memory; any real hash impl hiding behind that name
// is caught by `verifyNoInlineHashEmbeddings` below.
export const BANNED_EMBEDDING_IDENTIFIERS = [
  'HashEmbeddingProvider',
  'createHashEmbedding',
  'generateHashEmbedding',
  'hashEmbed',
  'embedWithFallback',
  'RvfEmbeddingService',
  'RvfEmbeddingCache',
];
// Literal pattern — `domain-aware-hash-384`, `domain-aware-hash-v1`, or
// anything else starting with the banned prefix.
export const BANNED_EMBEDDING_LITERAL_RE = /domain-aware-hash/;

// Files whose stated purpose is to *detect* the banned literal — the
// embedding-hygiene doctor (#651) reads it back out of the consumer's memory
// DB to flag residue rows. Compiled `.js` + `.d.ts` siblings are both skipped
// from the literal scan; identifier rules still apply repo-wide.
const BANNED_LITERAL_DETECTOR_FILES = new Set([
  'doctor-embedding-hygiene.js',
  'doctor-embedding-hygiene.d.ts',
]);

// Known regressions that still leak through until a dedicated fix lands. Each
// entry MUST reference the tracking issue. Leaking deps in this list are
// reported as WARN and do NOT cause the harness to exit non-zero; deps not in
// this list are hard failures. Trim entries here as fixes ship.
export const KNOWN_FORBIDDEN_REGRESSIONS = new Set();

function matchesForbidden(name) {
  for (const bad of FORBIDDEN_DEPS) {
    if (name === bad || (bad.startsWith('@') && name.startsWith(bad + '/'))) return true;
  }
  return false;
}

export function verifyDistHygiene(repoRoot) {
  section('Verify dist hygiene');
  const orphans = findOrphans();
  if (orphans.length === 0) {
    record('dist-orphans', 'pass', 'no orphaned compiled outputs');
    return;
  }
  const preview = orphans.slice(0, 5).map((o) => relative(repoRoot, o)).join(' | ');
  const suffix = orphans.length > 5 ? ` (+${orphans.length - 5} more)` : '';
  record('dist-orphans', 'fail', `${orphans.length} orphan(s): ${preview}${suffix}`);
}

export function packMoflo({ repoRoot, workDir, tarballOverride, skipPack }) {
  section('Pack moflo');

  if (tarballOverride) {
    if (!existsSync(tarballOverride)) throw new Error(`--tarball not found: ${tarballOverride}`);
    record('pack', 'pass', `reusing ${relative(repoRoot, tarballOverride)}`);
    return tarballOverride;
  }

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  if (skipPack) {
    const existing = readdirSync(workDir).filter(f => f.startsWith('moflo-') && f.endsWith('.tgz'));
    if (existing.length > 0) {
      record('pack', 'pass', `reused ${existing[0]}`);
      return join(workDir, existing[0]);
    }
    log('No existing tarball found; packing anyway.');
  }

  const r = run(NPM_CMD, ['pack', '--pack-destination', workDir, '--silent'], {
    cwd: repoRoot,
    capture: true,
    timeout: 300_000,
  });
  if (r.code !== 0) {
    record('pack', 'fail', `npm pack exit ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
    throw new Error('pack failed');
  }
  const files = readdirSync(workDir).filter(f => f.startsWith('moflo-') && f.endsWith('.tgz'));
  if (files.length === 0) {
    record('pack', 'fail', 'no tgz produced');
    throw new Error('pack failed');
  }
  files.sort((a, b) => statSync(join(workDir, b)).mtimeMs - statSync(join(workDir, a)).mtimeMs);
  const tarball = join(workDir, files[0]);
  record('pack', 'pass', files[0]);
  return tarball;
}

export function installConsumer({ workDir, tarballPath }) {
  section('Install into scratch consumer');
  const consumerDir = join(workDir, `consumer-${Date.now()}`);
  mkdirSync(consumerDir, { recursive: true });

  const pkg = {
    name: 'moflo-consumer-smoke',
    version: '0.0.0',
    private: true,
    type: 'module',
    devDependencies: { moflo: `file:${tarballPath.replace(/\\/g, '/')}` },
  };
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify(pkg, null, 2));

  const r = run(
    NPM_CMD,
    ['install', '--no-audit', '--no-fund', '--loglevel=error', '--legacy-peer-deps'],
    { cwd: consumerDir, capture: true, timeout: 600_000 },
  );
  if (r.code !== 0) {
    record('install', 'fail', `npm install exit ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
    throw new Error('install failed');
  }

  const installedPkg = join(consumerDir, 'node_modules', 'moflo', 'package.json');
  if (!existsSync(installedPkg)) {
    record('install', 'fail', 'node_modules/moflo/package.json missing');
    throw new Error('install failed');
  }
  const { version } = JSON.parse(readFileSync(installedPkg, 'utf8'));
  record('install', 'pass', `moflo@${version}`);
  return consumerDir;
}

/**
 * #1088 broken-window gate. The bug class: any moflo writer that resolves
 * paths via `findProjectRoot()` will walk past the consumer dir and land
 * on whatever moflo-shaped ancestor is above it. That ancestor used to be
 * the moflo source repo (workDir under `harness/consumer-smoke/.work`),
 * which produced #1088 + cousins #1054/#1057/#1058. The structural fix is
 * to put the consumer in `os.tmpdir()` — but a sane place + a future
 * accidental nesting (e.g. someone runs the harness from inside another
 * moflo repo, or `tmpdir()` itself ever grows a `.moflo/`) would silently
 * re-introduce the mismatch.
 *
 * This gate runs early and asserts `findProjectRoot()` from inside the
 * consumer dir returns the consumer dir itself. If anything above the
 * consumer has a `.moflo/moflo.db`, `.swarm/memory.db`, or
 * `CLAUDE.md + package.json` marker pair, the resolver picks it up first
 * and we hard-fail HERE — at a single, named gate — instead of a probe
 * 30 checks downstream returning a confusing `not found` error.
 */
export function verifyConsumerIsProjectRoot(consumerDir) {
  section('Verify findProjectRoot resolves to the consumer dir (#1088)');
  const probe = join(consumerDir, '_project-root-gate.mjs');
  const mofloPathsPath = join(consumerDir, 'node_modules', 'moflo', 'bin', 'lib', 'moflo-paths.mjs');
  if (!existsSync(mofloPathsPath)) {
    record('project-root-gate', 'fail', `bin/lib/moflo-paths.mjs missing from install: ${mofloPathsPath}`);
    return;
  }
  writeFileSync(probe, `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(mofloPathsPath)}).href);
console.log(JSON.stringify({
  cwd: process.cwd(),
  resolved: mod.findProjectRoot({ honorEnv: false }),
}));
`);
  const r = runNode(probe, [], { cwd: consumerDir, timeout: 15_000 });
  try { rmSync(probe, { force: true }); } catch { /* ok */ }
  if (r.code !== 0) {
    record('project-root-gate', 'fail', `probe exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    throw new Error('project-root gate failed');
  }
  let parsed;
  // Split on /\r?\n/ so a Windows CRLF line ending doesn't leave a trailing
  // '\r' on the popped value and trip JSON.parse (cf. fix(1054) in launcher).
  try { parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch {
    record('project-root-gate', 'fail', `probe stdout not JSON: ${r.stdout.trim().slice(0, 200)}`);
    throw new Error('project-root gate failed');
  }
  // Normalize for:
  //   - Windows case-insensitivity + backslash separators
  //   - macOS /var → /private/var symlink (os.tmpdir() returns /var/...;
  //     process.cwd() inside the subprocess returns the realpath
  //     /private/var/... — string compare without realpath divergence FPs).
  const norm = (p) => {
    let r = p;
    try { r = realpathSync(p); } catch { /* path may not exist on either side; fall through */ }
    return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  };
  if (norm(parsed.resolved) !== norm(consumerDir)) {
    record(
      'project-root-gate',
      'fail',
      `findProjectRoot resolved to "${parsed.resolved}", expected "${consumerDir}". ` +
      `An ancestor of the consumer dir has a moflo marker (.moflo/moflo.db, .swarm/memory.db, ` +
      `or CLAUDE.md+package.json) — every downstream daemon/bridge/probe will read/write the ` +
      `wrong file. Run the harness from a workDir that has no moflo-shaped ancestors ` +
      `(default: os.tmpdir()/moflo-consumer-smoke).`,
    );
    throw new Error('project-root gate failed');
  }
  record('project-root-gate', 'pass', `consumer is its own project root (${norm(consumerDir)})`);
}

export function verifyForbiddenDeps(consumerDir) {
  section('Verify forbidden transitive deps absent');
  const nm = join(consumerDir, 'node_modules');

  // A flat scan of node_modules/ catches direct + hoisted deps, which is what
  // consumers see. Nested-install detection via `npm ls --all --json` spawns a
  // full npm CLI for ~1–3s of overhead; skip it — these packages don't bundle.
  const leaked = new Set();
  for (const name of readdirSync(nm)) {
    const full = join(nm, name);
    if (name.startsWith('@')) {
      for (const sub of readdirSync(full)) {
        const qualified = `${name}/${sub}`;
        if (matchesForbidden(qualified) || matchesForbidden(name)) leaked.add(qualified);
      }
    } else if (matchesForbidden(name)) {
      leaked.add(name);
    }
  }

  const hardFails = [...leaked].filter(d => !KNOWN_FORBIDDEN_REGRESSIONS.has(d));
  if (hardFails.length > 0) {
    record('forbidden-deps', 'fail', `leaked: ${hardFails.join(', ')}`);
  } else {
    record('forbidden-deps', 'pass', `${FORBIDDEN_DEPS.length - leaked.size}/${FORBIDDEN_DEPS.length} clean`);
  }
  for (const w of [...leaked].filter(d => KNOWN_FORBIDDEN_REGRESSIONS.has(d))) {
    record(`forbidden-deps:${w}`, 'warn', 'known regression — leaking until tracking fix lands');
  }
}

/**
 * Epic #527 story #532: asserts every required dep landed in the consumer
 * install. If `fastembed` is missing, moflo has either regressed to
 * hash-fallback or the publish manifest is broken — either way, hard fail.
 */
export function verifyRequiredDeps(consumerDir) {
  section('Verify required deps present');
  const nm = join(consumerDir, 'node_modules');
  const missing = [];
  for (const name of REQUIRED_DEPS) {
    const dir = name.startsWith('@')
      ? join(nm, ...name.split('/'))
      : join(nm, name);
    if (!existsSync(join(dir, 'package.json'))) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    record('required-deps', 'fail', `missing: ${missing.join(', ')}`);
    return;
  }
  record('required-deps', 'pass', `${REQUIRED_DEPS.join(', ')} present`);
}

/**
 * Structural check for hash-embedding leaks in the moflo dist tree.
 *
 * A file is a hash-embedding if it allocates a `Float32Array`, calls
 * `charCodeAt`, and matches one of the three signatures that turn a
 * per-character hash into embedding cells:
 *
 *   - `Math.sin(hash)` — classic sin-scramble (every `MockEmbeddingService`
 *     style fallback epic #527 tried to delete), required within an 800-char
 *     window of a `charCodeAt` call.
 *   - `hash / 0xffffffff` — FNV-style divide-by-max-uint used by the
 *     migration driver's `seedVector`, same proximity window.
 *   - `arr[i] = … .charCodeAt(…)` — direct indexer assignment from a
 *     `charCodeAt` expression, matched on a single statement.
 *
 * The proximity + direct-assignment requirements let legitimate co-use of
 * `Float32Array` + `charCodeAt` pass: RL state hashing (neural algorithms,
 * q-learning router), FNV cache-key hashing (embeddings persistent cache),
 * and benchmark math all mix the primitives in the same file but never in
 * the same function, so neither branch matches.
 *
 * Layered on top of the identifier guard because the identifier ban alone
 * missed the inline implementations removed in #542. Issue #545 unscoped
 * the rule from swarm-only to the whole moflo install.
 */
const HASH_EMBED_RE =
  /charCodeAt\([\s\S]{0,800}(?:Math\.sin\(|\/\s*0x[fF]{8}\b)|(?:Math\.sin\(|\/\s*0x[fF]{8}\b)[\s\S]{0,800}charCodeAt\(|\w+\[[^\]]*\]\s*=[^=;\n]*\.charCodeAt\(/;

export function verifyNoInlineHashEmbeddings(consumerDir) {
  section('Verify no inline hash embeddings in moflo dist');
  const mofloDir = join(consumerDir, 'node_modules', 'moflo');
  if (!existsSync(mofloDir)) {
    record('no-inline-hash-embeddings', 'fail', 'node_modules/moflo missing');
    return;
  }

  const hits = [];
  let filesScanned = 0;
  for (const file of walkJsFiles(mofloDir)) {
    // Skip .d.ts — typings can't instantiate Float32Array or call charCodeAt,
    // but a substring check would false-match their return-type positions.
    if (file.endsWith('.d.ts')) continue;

    filesScanned++;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      log(`  skipped unreadable file ${file}: ${err.message}`);
      continue;
    }
    if (
      text.includes('new Float32Array(') &&
      text.includes('charCodeAt(') &&
      HASH_EMBED_RE.test(text)
    ) {
      hits.push(relative(consumerDir, file));
    }
  }

  if (hits.length > 0) {
    const preview = hits.slice(0, 5).join(' | ');
    const suffix = hits.length > 5 ? ` (+${hits.length - 5} more)` : '';
    record(
      'no-inline-hash-embeddings',
      'fail',
      `inline hash-embedding pattern leaked into moflo dist — ${hits.length} file(s): ${preview}${suffix}`,
    );
    return;
  }
  record(
    'no-inline-hash-embeddings',
    'pass',
    `${filesScanned} JS file(s) scanned, no inline hash pattern`,
  );
}

/**
 * Epic #527 story #532: scans the installed moflo dist tree for any banned
 * hash-embedding identifier. The ESLint guard catches these in source; this
 * check catches them in compiled output — e.g. a bundled copy, a transform
 * that resurrects a deleted helper, or a vendored file that slipped past
 * lint.
 */
export function verifyNoBannedEmbeddings(consumerDir) {
  section('Verify no banned embedding identifiers in dist');
  const mofloDir = join(consumerDir, 'node_modules', 'moflo');
  if (!existsSync(mofloDir)) {
    record('no-banned-embeddings', 'fail', 'node_modules/moflo missing');
    return;
  }

  const identifierRe = new RegExp(`\\b(${BANNED_EMBEDDING_IDENTIFIERS.join('|')})\\b`);
  const bannedRe = new RegExp(
    `\\b(${BANNED_EMBEDDING_IDENTIFIERS.join('|')})\\b|${BANNED_EMBEDDING_LITERAL_RE.source}`,
  );

  const hits = [];
  let filesScanned = 0;

  for (const file of walkJsFiles(mofloDir)) {
    filesScanned++;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      log(`  skipped unreadable file ${file}: ${err.message}`);
      continue;
    }
    // The hygiene doctor file is the legitimate literal detector — only the
    // identifier rules apply there.
    const re = BANNED_LITERAL_DETECTOR_FILES.has(basename(file)) ? identifierRe : bannedRe;
    const match = text.match(re);
    if (match) {
      hits.push({ file, match: match[0] });
    }
  }

  if (hits.length > 0) {
    const preview = hits
      .slice(0, 5)
      .map(h => `${relative(consumerDir, h.file)}:${h.match}`)
      .join(' | ');
    const suffix = hits.length > 5 ? ` (+${hits.length - 5} more)` : '';
    record(
      'no-banned-embeddings',
      'fail',
      `hash-embedding code leaked into dist — ${hits.length} hit(s): ${preview}${suffix}`,
    );
    return;
  }

  record(
    'no-banned-embeddings',
    'pass',
    `${filesScanned} JS file(s) scanned, no banned identifiers`,
  );
}

function* walkJsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log(`  walkJsFiles: cannot read ${dir}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    // Don't recurse into nested node_modules — moflo doesn't bundle its deps,
    // so anything under moflo/node_modules is someone else's code and not
    // our concern. This also prevents the scan from exploding in size.
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walkJsFiles(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    // Issue #545: `.d.ts` files are emitted alongside `.js` for TS packages
    // and can carry re-exports of banned symbols (`export { hashEmbed }`).
    // The previous `/\.(m?js|cjs)$/` filter skipped them entirely.
    if (!/\.(m?js|cjs|d\.ts)$/.test(entry.name)) continue;
    yield join(dir, entry.name);
  }
}

export function cliLoads(consumerDir) {
  section('CLI loads');
  const r = flo(consumerDir, ['--version']);
  if (r.code !== 0 || !/v?\d+\.\d+\.\d+/.test(r.stdout)) {
    record('cli-version', 'fail', `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    return;
  }
  record('cli-version', 'pass', r.stdout.trim().slice(0, 60));
}

// Issue #784: warning-status checks that are legitimately allowed on a
// fresh consumer install in CI. These are the *only* warnings that don't
// fail the smoke; every other warn is treated as a regression.
//
// Each entry must match an exact `name:` literal in src/cli/commands/doctor.ts
// (or doctor-checks-deep.ts) — equality match in --strict mode rejects typos
// silently otherwise. Verify with:
//   grep -nE "name:\s*['\"][^'\"]+['\"]" src/cli/commands/doctor*.ts
//
//   - "Sandbox Tier"     — probes for Docker; macOS/Windows CI runners and
//                          bare Linux runners don't have it.
//   - "Claude Code CLI"  — `claude` CLI not installed in a fresh fixture.
//   - "MCP Servers"      — no Claude/MCP config in a bare fixture.
//   - "Status Line"      — wired by `moflo init`, which the smoke fixture
//                          intentionally skips (it tests the tarball, not
//                          the init flow).
//   - "Daemon Status"    — daemon isn't running in a smoke fixture.
//   - "Config File"      — no `.moflo/config.yaml` in a bare consumer.
//   - "moflo.yaml"       — auto-created by session-start launcher (#895),
//                          which the smoke fixture skips. Same posture as
//                          "Status Line" / "Config File".
//   - "Memory Database"  — was unwarned because the DB didn't exist yet.
//                          Doctor's Memory Access Functional check (#844)
//                          now writes a probe row and auto-creates the DB,
//                          so this line typically passes — kept on the
//                          allowlist for the legacy "DB doesn't exist yet"
//                          path that still surfaces if the new check is
//                          disabled or its memory tools aren't built.
//   - "Test Directories" / "Git Repository" — fresh consumer fixture
//                          isn't a real project repo.
const SMOKE_ALLOWED_DOCTOR_WARNINGS = [
  'Sandbox Tier',
  'Claude Code CLI',
  'MCP Servers',
  'Status Line',
  'Daemon Status',
  'Config File',
  'moflo.yaml',       // session-start auto-create not exercised in smoke (#895)
  'Memory Database',  // smoke runs `memory init` AFTER doctor
  'Embeddings',       // depends on Memory Database
  'Test Directories',
  'Git Repository',
  'Gate Health',      // .claude/ not initialised in fresh fixture (warn since #784)
  'Hook Block Drift', // settings.json not found in fresh fixture (warn since #888)
  'Semantic Quality', // empty DB, no patterns yet
  'Disk Space',       // macOS GitHub runner is constantly >80% used (warn threshold)
  'TypeScript',       // a fresh consumer fixture in os.tmpdir() has no tsc on PATH
                      // (pre-#1088 the fixture lived inside the moflo repo and
                      // inherited the repo's node_modules/.bin/tsc via npx walk-up)
];

export function doctor(consumerDir) {
  section('Doctor');
  // Defence-in-depth: sweep any host-level orphans introduced by the
  // harness's own probes before --strict runs. Does NOT mask production
  // zombie detection — only the harness's pre-probe state.
  flo(consumerDir, ['healer', '--kill-zombies'], { timeout: 30_000 });
  // Issue #784: --strict flips warns→exit 1. Allowlist above keeps known
  // CI-environment warns from blocking the smoke; any unrecognised warn
  // (like the 4.9.0-rc.11 Sandbox-Tier silent-catch case) fails the run.
  const r = flo(
    consumerDir,
    ['doctor', '--strict', '--allow-warn', SMOKE_ALLOWED_DOCTOR_WARNINGS.join(',')],
    { timeout: 60_000 },
  );
  // recordExit truncates output to 200 chars; doctor failures need the full
  // tail (especially the "warnings not allowlisted" list) to be debuggable
  // from CI logs without a re-run.
  if (r.code !== 0) {
    log('--- doctor full output (exit non-zero) ---');
    log(r.stdout);
    if (r.stderr) {
      log('--- doctor stderr ---');
      log(r.stderr);
    }
    log('--- end doctor output ---');
  }
  recordExit('doctor', r, { okCodes: [0] });
}

export function memoryInit(consumerDir) {
  section('Memory initialization');
  // --force: doctor's Memory Access Functional check (#844) writes a probe
  // row and auto-creates the DB before this step runs. memory init refuses
  // an existing DB without --force; passing it makes the smoke harness
  // robust to ANY pre-existing DB state (doctor probe today, future
  // background indexer tomorrow).
  const r = flo(consumerDir, ['memory', 'init', '--force'], { timeout: 120_000 });
  if (!recordExit('memory-init', r)) throw new Error('memory init failed');
}

/**
 * Issue #994: dump full stdout + stderr for a memory-CRUD subprocess so a
 * future flake gives us the actual error, not a 200-char tail. recordExit's
 * built-in truncation hid the real failure on Ubuntu (the onnxruntime
 * GetPciBusId warning consumed the entire visible window).
 */
function dumpFullCrudOutput(label, res) {
  log(`--- ${label} full output (failure dump) ---`);
  log(`exit ${res.code}`);
  if (res.stdout) {
    log('--- stdout ---');
    log(res.stdout);
  }
  if (res.stderr) {
    log('--- stderr ---');
    log(res.stderr);
  }
  log(`--- end ${label} ---`);
}

export function memoryCrud(consumerDir) {
  section('Memory CRUD round-trip');

  // Issue #1028: confine the round-trip to the bridge-direct path. The
  // runtime contract for cross-process memory visibility is daemon-
  // coordinated, but `flo memory retrieve` has no daemon-routed read — so a
  // daemon-up CRUD round-trip races the daemon's flush against the harness's
  // bridge-direct read. Mirroring #1029 (#1022): move the test environment
  // out of the daemon's territory by disabling daemon auto-start in the
  // consumer and stopping any daemon prior checks may have started. With
  // auto-start off the next `flo memory <op>` falls through `storeEntry` to
  // `bridgeStoreEntry` in-process, sequential subprocesses + atomicWrite
  // (fsync → rename → Win post-rename verify) make the round-trip
  // deterministic. Daemon-coordinated CRUD has dedicated coverage at
  // src/cli/__tests__/memory/store-entry-routing.test.ts and
  // src/cli/__tests__/services/daemon-memory-rpc.test.ts.
  //
  // Localized to memoryCrud: try/finally restores any prior moflo.yaml so
  // downstream checks see the same environment they would have without the
  // intervention (the smoke fixture intentionally ships without one — see
  // SMOKE_ALLOWED_DOCTOR_WARNINGS).
  const yamlPath = join(consumerDir, 'moflo.yaml');
  const priorYaml = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : null;
  writeFileSync(yamlPath, 'daemon:\n  auto_start: false\n');
  stopConsumerDaemon(consumerDir);

  try {
    const key = `smoke-${Date.now()}`;
    const value = 'smoke-harness-sentinel';

    const store = flo(consumerDir, ['memory', 'store', '-k', key, '-v', value, '--namespace', 'smoke']);
    if (!recordExit('memory-store', store)) dumpFullCrudOutput('memory-store', store);

    // Issue #994: use --format=json so the round-trip check parses a structured
    // payload instead of grepping the ASCII printBox output. The box rendering
    // intermittently dropped its content rows on Windows CI (top/bottom borders
    // landed in captured stdout, the inner `| Namespace: ... |` lines didn't —
    // looked like a writeback race in the harness output but turned out to be
    // a stdout-flush issue downstream of printBox). JSON output goes through
    // a single console.log call and is what callers should rely on anyway.
    const get = flo(consumerDir, ['memory', 'retrieve', '-k', key, '--namespace', 'smoke', '--format', 'json']);
    let parsedContent = null;
    if (get.code === 0) {
      try { parsedContent = JSON.parse(get.stdout.trim())?.content ?? null; }
      catch { /* fall through to fail with the raw exit/stdout */ }
    }
    const ok = parsedContent === value;
    record('memory-retrieve', ok ? 'pass' : 'fail',
      ok ? 'value round-trips' : `exit ${get.code}, content=${JSON.stringify(parsedContent)}`);
    if (!ok) dumpFullCrudOutput('memory-retrieve', get);

    recordExit('memory-search', flo(consumerDir, ['memory', 'search', '-q', 'smoke', '--namespace', 'smoke', '--limit', '5']));

    recordExit('memory-list', flo(consumerDir, ['memory', 'list', '--namespace', 'smoke']));

    recordExit('memory-delete', flo(consumerDir, ['memory', 'delete', '-k', key, '--namespace', 'smoke']));
  } finally {
    if (priorYaml !== null) writeFileSync(yamlPath, priorYaml);
    else {
      try { rmSync(yamlPath); }
      catch { /* benign — file may have been removed by a subprocess */ }
    }
  }
}

/**
 * Cross-process moflo.db single-writer invariant (#1054.S6 / #1060).
 *
 * Starts the consumer's real daemon, then spawns two parallel Node
 * subprocesses that each `POST /api/memory/store` directly to the daemon —
 * the daemon's single sql.js handle is the only writer that touches
 * `.moflo/moflo.db`. A third process (the harness itself) reads both keys
 * back via the daemon's `/api/memory/get` — proves no clobber and proves
 * visibility is cross-process, not just same-process cache.
 *
 * Why the writer subprocesses bypass `tryDaemonStore` and hit the HTTP
 * endpoint themselves: the client's first-call health probe has a 100ms
 * timeout and silently falls back to direct write on miss. That fallback IS
 * the bug class — it's what produced the writeback-clobber pattern this
 * gate exists to detect. Driving the daemon RPC directly isolates the
 * cross-process invariant from the client-side probe race.
 *
 * Pre-fix: any second writer holding its own sql.js snapshot would clobber
 * the first writer's row on flush. Post-fix: both writes survive because the
 * daemon owns the only sql.js handle and serialises the RPC stream.
 *
 * Hard-fail. Per #1054 acceptance criteria and `feedback_broken_window_theory`,
 * a regression here ships the writeback-clobber bug class to consumers.
 */
export async function crossProcessNoClobber(consumerDir) {
  section('Cross-process moflo.db single-writer invariant (#1060)');

  // memoryCrud's finally restored its own yaml writes; make sure the daemon
  // is enabled for this check by clearing any leftover yaml. Restore prior
  // state on exit so downstream checks see what they expect.
  const yamlPath = join(consumerDir, 'moflo.yaml');
  const priorYaml = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : null;
  if (priorYaml !== null) {
    try { rmSync(yamlPath); } catch { /* ok */ }
  }

  const scriptPaths = [];
  try {
    // 1) Start the real consumer daemon and wait until its HTTP endpoint is
    //    reachable. Bound the wait so a stuck daemon can't hold up the matrix.
    const startRes = flo(consumerDir, ['daemon', 'start', '--quiet'], { timeout: 30_000 });
    if (startRes.code !== 0) {
      record('cross-process-no-clobber:daemon-start', 'fail',
        `flo daemon start exit ${startRes.code}: ${(startRes.stderr || startRes.stdout).trim().slice(0, 200)}`);
      return;
    }

    const port = parseInt(process.env.MOFLO_DAEMON_PORT || '3117', 10);
    const ready = await waitForDaemon(port, 15_000);
    if (!ready) {
      record('cross-process-no-clobber:daemon-start', 'fail',
        `daemon did not become reachable at 127.0.0.1:${port} within 15s`);
      return;
    }
    record('cross-process-no-clobber:daemon-start', 'pass', `daemon reachable on 127.0.0.1:${port}`);

    // 2) Spawn two parallel writers. Both import the shipped dist initializer
    //    so they exercise the exact code path consumers run.
    const ns = 'smoke-1060';
    const tag = randomBytes(6).toString('hex');
    const keyA = `A:smoke-${tag}`;
    const valueA = `A-value-${tag}`;
    const keyB = `B:smoke-${tag}`;
    const valueB = `B-value-${tag}`;

    const [resA, resB] = await Promise.all([
      spawnNoClobberWriter(consumerDir, port, { key: keyA, value: valueA, namespace: ns }, scriptPaths),
      spawnNoClobberWriter(consumerDir, port, { key: keyB, value: valueB, namespace: ns }, scriptPaths),
    ]);

    if (!resA.ok || !resB.ok) {
      const detail = [
        resA.ok ? null : `writer-A: ${resA.error}`,
        resB.ok ? null : `writer-B: ${resB.error}`,
      ].filter(Boolean).join(' | ');
      record('cross-process-no-clobber:parallel-writes', 'fail', detail);
      return;
    }
    record('cross-process-no-clobber:parallel-writes', 'pass', 'both writers reported success');

    // 3) Read both keys back from a third process (the harness) via the
    //    daemon's HTTP RPC. If either is missing, the second writer's flush
    //    clobbered the first.
    const [gotA, gotB] = await Promise.all([
      daemonGetEntry(port, ns, keyA),
      daemonGetEntry(port, ns, keyB),
    ]);

    const missing = [];
    if (!gotA.found) missing.push(keyA);
    if (!gotB.found) missing.push(keyB);
    if (missing.length > 0) {
      const listed = await daemonListNamespace(port, ns);
      record('cross-process-no-clobber:visibility', 'fail',
        `clobber detected — missing: ${missing.join(', ')}; daemon /list ns=${ns}: ${JSON.stringify(listed)}; gotA=${JSON.stringify(gotA)}; gotB=${JSON.stringify(gotB)}`);
      return;
    }
    if (gotA.content !== valueA || gotB.content !== valueB) {
      record('cross-process-no-clobber:visibility', 'fail',
        `value mismatch — A.content=${JSON.stringify(gotA.content)}, B.content=${JSON.stringify(gotB.content)}`);
      return;
    }
    record('cross-process-no-clobber:visibility', 'pass',
      'both keys readable from a third process — single-writer invariant holds');

    // 4) Cleanup the smoke namespace so we don't leak rows into later checks.
    await Promise.all([
      daemonDeleteEntry(port, ns, keyA),
      daemonDeleteEntry(port, ns, keyB),
    ]);
  } finally {
    for (const p of scriptPaths) {
      try { rmSync(p, { force: true }); } catch { /* ok */ }
    }
    stopConsumerDaemon(consumerDir);
    if (priorYaml !== null) writeFileSync(yamlPath, priorYaml);
  }
}

function waitForDaemon(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      probeDaemonStatus(port).then((ok) => {
        if (ok) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function probeDaemonStatus(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/status', timeout: 1_000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function spawnNoClobberWriter(consumerDir, port, { key, value, namespace }, scriptPaths) {
  return new Promise((resolve) => {
    const scriptPath = join(consumerDir, `writer-${randomBytes(6).toString('hex')}.mjs`);
    scriptPaths.push(scriptPath);

    // Drive the daemon RPC directly via HTTP. The #1060 invariant is about
    // the cross-process write path itself — does the daemon serialize two
    // concurrent stores without clobber? Going through tryDaemonStore would
    // let a slow first-call /api/status probe silently fall back to direct
    // write (the bug class), masking the very regression this gate exists
    // to detect. Daemon-write-client's contract is tested elsewhere; this
    // fixture isolates the cross-process invariant.
    const script = `
import * as http from 'node:http';

function postJson(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: ${JSON.stringify(port)},
      path,
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* ignore */ }
        resolve({ status: res.statusCode, body: parsed });
      });
      res.on('error', () => resolve({ status: 0, body: null, error: 'response-error' }));
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

try {
  const r = await postJson('/api/memory/store', {
    key: ${JSON.stringify(key)},
    value: ${JSON.stringify(value)},
    namespace: ${JSON.stringify(namespace)},
  });
  process.stdout.write(JSON.stringify(r));
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err && err.stack || err));
  process.exit(2);
}
`;
    writeFileSync(scriptPath, script);

    const proc = spawn(process.execPath, [scriptPath], {
      cwd: consumerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err) => {
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `exit ${code}: ${(stderr || stdout).trim().slice(0, 200)}` });
        return;
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch {
        resolve({ ok: false, error: `unparsable stdout: ${stdout.trim().slice(0, 200)}` });
        return;
      }
      const status = parsed?.status;
      if (typeof status !== 'number' || status < 200 || status >= 300) {
        resolve({
          ok: false,
          error: `daemon HTTP store rejected — status=${status} body=${JSON.stringify(parsed?.body)} err=${parsed?.error ?? ''}`,
        });
        return;
      }
      if (parsed?.body?.ok !== true || parsed?.body?.stored !== true) {
        resolve({ ok: false, error: `daemon body not ok/stored: ${JSON.stringify(parsed?.body)}` });
        return;
      }
      resolve({ ok: true });
    });
  });
}

function daemonGetEntry(port, namespace, key) {
  return postDaemonJson(port, '/api/memory/get', { namespace, key }).then((res) => {
    if (!res.ok) return { found: false, content: null, _diag: { status: res.status } };
    return {
      found: !!res.data?.found,
      content: res.data?.entry?.content ?? null,
    };
  });
}

function daemonListNamespace(port, namespace) {
  return postDaemonJson(port, '/api/memory/list', { namespace, limit: 50 }).then((res) => {
    if (!res.ok) return { _status: res.status };
    return {
      total: res.data?.total,
      keys: Array.isArray(res.data?.entries) ? res.data.entries.map((e) => e.key) : null,
    };
  });
}

function daemonDeleteEntry(port, namespace, key) {
  return postDaemonJson(port, '/api/memory/delete', { namespace, key });
}

function postDaemonJson(port, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        timeout: 5_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({ ok: false, status });
            return;
          }
          try { resolve({ ok: true, data: JSON.parse(buf) }); }
          catch { resolve({ ok: false, status }); }
        });
        res.on('error', () => resolve({ ok: false }));
      },
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.write(payload);
    req.end();
  });
}

/**
 * Issue #756: `flo spell schedule create --cron <invalid>` must fail strict
 * validation in a consumer install. Regression catches the
 * fixed-depth-`../../../../spells/dist/...` import that silently fell back to
 * a permissive regex when the path resolved to nothing in node_modules layouts.
 *
 * "Strict" here means the cron-parser is actually loaded and rejects garbage
 * — not just that the timing-options arity check trips first. We assert
 * non-zero exit AND a clear error message, but we DO NOT assert "Invalid
 * schedule" verbatim because output formatting is allowed to evolve.
 */
export function spellScheduleStrictCron(consumerDir) {
  section('Spell schedule strict cron validation (issue #756)');

  const r = flo(
    consumerDir,
    ['spell', 'schedule', 'create', '-n', 'smoke-756', '--cron', 'a b c d e'],
    { timeout: 60_000 },
  );

  if (r.code === 0) {
    record(
      'spell-schedule-strict-cron',
      'fail',
      `garbage cron 'a b c d e' was accepted (exit 0) — strict validator is not loading; ` +
        `stdout: ${r.stdout.trim().slice(0, 200)}`,
    );
    return;
  }

  // Confirm the rejection mentions the cron field, not e.g. a missing-name
  // error or some unrelated crash. Both stdout and stderr are scanned because
  // `output.printError` writes to either depending on TTY detection.
  const combined = `${r.stdout}\n${r.stderr}`;
  if (!/cron|Invalid schedule/i.test(combined)) {
    record(
      'spell-schedule-strict-cron',
      'fail',
      `non-zero exit ${r.code} but no cron-rejection message; ` +
        `output: ${combined.trim().slice(0, 200)}`,
    );
    return;
  }

  record('spell-schedule-strict-cron', 'pass', `rejected with exit ${r.code}`);
}

export function spellList(consumerDir) {
  section('Spell engine');
  // Issue #755: shipped grimoire must contain the epic spells out of the box.
  // Both spells live in `src/cli/spells/definitions/` and are published via the
  // package.json files entry of the same name. A clean install must list them.
  const r = flo(consumerDir, ['spell', 'list'], { timeout: 60_000 });
  if (r.code !== 0) {
    record('spell-list', 'fail', `exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return;
  }
  record('spell-list', 'pass');
  const out = r.stdout;
  if (!/\bepic-single-branch\b/.test(out)) {
    record('spell-list:epic-single-branch', 'fail', 'epic-single-branch missing from shipped grimoire');
  } else {
    record('spell-list:epic-single-branch', 'pass');
  }
  if (!/\bepic-auto-merge\b/.test(out)) {
    record('spell-list:epic-auto-merge', 'fail', 'epic-auto-merge missing from shipped grimoire');
  } else {
    record('spell-list:epic-auto-merge', 'pass');
  }
}

export function mcpTools(consumerDir) {
  section('MCP tools surface');
  const r = flo(consumerDir, ['mcp', 'tools']);
  if (r.code !== 0) {
    record('mcp-tools', 'fail', `exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return;
  }
  const out = r.stdout;
  if (!/\bmoflodb_health\b/.test(out)) {
    record('mcp-tools:moflodb', 'fail', 'moflodb_health missing from tools list');
  } else {
    record('mcp-tools:moflodb', 'pass');
  }
  if (/\bagentdb_health\b/.test(out)) {
    record('mcp-tools:no-legacy', 'fail', 'legacy agentdb_* tools still registered');
  } else {
    record('mcp-tools:no-legacy', 'pass');
  }
  // #1053 S2: memory_get_neighbors must be in the registered surface so
  // any future stub/disconnect breaks the smoke run before consumers see it.
  if (!/\bmemory_get_neighbors\b/.test(out)) {
    record('mcp-tools:memory_get_neighbors', 'fail', 'memory_get_neighbors missing from tools list (#1053 S2)');
  } else {
    record('mcp-tools:memory_get_neighbors', 'pass');
  }
}

/**
 * #1053 S3 + S4: epic-specific assertions on a fresh consumer install.
 *  - subagent-bootstrap.json directive contains the traversal crumb (one of
 *    the 6 protocol touchpoints — drift-guards in moflo's own test tree pin
 *    the source, this pins the shipped tarball)
 *  - memory_get_neighbors handler returns a shaped neighbor envelope when
 *    fed a chunk-shaped row (proves S1 metadata passthrough + S2 wiring
 *    survives pack → install round-trip, not just runs in-tree)
 *  - shipped/moflo-memory-protocol.md is present in node_modules
 *  - clean install carries zero `doc-*` rows (#1053 S4 — chunker stopped
 *    writing them; smoke runs against an empty DB so this is just a
 *    presence/no-residue sanity check)
 */
export function memoryTraversalProtocol(consumerDir) {
  section('Memory traversal protocol (#1053)');

  const bootstrapPath = join(consumerDir, 'node_modules', 'moflo', '.claude', 'helpers', 'subagent-bootstrap.json');
  if (!existsSync(bootstrapPath)) {
    record('memory-protocol:bootstrap-shipped', 'fail', 'subagent-bootstrap.json missing from package');
  } else {
    let directive;
    try {
      directive = JSON.parse(readFileSync(bootstrapPath, 'utf-8')).directive;
    } catch (err) {
      record('memory-protocol:bootstrap-parse', 'fail', `JSON parse failed: ${err.message}`);
      directive = '';
    }
    const hasNeighbors = directive.includes('memory_get_neighbors');
    const hasProtocolDoc = directive.includes('moflo-memory-protocol.md');
    if (hasNeighbors && hasProtocolDoc) {
      record('memory-protocol:bootstrap-directive', 'pass', 'directive cites neighbors tool + protocol doc');
    } else {
      record('memory-protocol:bootstrap-directive', 'fail',
        `directive missing crumbs (neighbors=${hasNeighbors}, protocol-doc=${hasProtocolDoc})`);
    }
  }

  const protocolDoc = join(consumerDir, 'node_modules', 'moflo', '.claude', 'guidance', 'shipped', 'moflo-memory-protocol.md');
  if (!existsSync(protocolDoc)) {
    record('memory-protocol:doc-shipped', 'fail', 'shipped/moflo-memory-protocol.md missing from package');
  } else {
    const lineCount = readFileSync(protocolDoc, 'utf-8').split('\n').length;
    if (lineCount > 40) {
      record('memory-protocol:doc-shipped', 'fail', `protocol doc grew past 40-line cap (${lineCount} lines)`);
    } else {
      record('memory-protocol:doc-shipped', 'pass', `${lineCount} lines, within 40-line cap`);
    }
  }

  // memory_get_neighbors handler probe — drives the same dist surface a
  // consumer Claude Code session would. Stores a chunk-shaped row + calls
  // the tool's handler in-process via the consumer's `node_modules/moflo/`.
  const probe = join(consumerDir, 'memory-neighbors-probe.mjs');
  const memToolsPath = join(consumerDir, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'mcp-tools', 'memory-tools.js')
    .replace(/\\/g, '/');
  writeFileSync(probe, `
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
const mod = await import(pathToFileURL(${JSON.stringify(memToolsPath)}).href);
const tools = mod.memoryTools;
const get = name => tools.find(t => t.name === name);

const store = get('memory_store');
const neighbors = get('memory_get_neighbors');
const del = get('memory_delete');

if (!store || !neighbors || !del) {
  console.log(JSON.stringify({ ok: false, reason: 'tools missing', tools: tools.map(t => t.name) }));
  process.exit(0);
}

// Seed three chunks via memory_store with chunk-shaped metadata in-band
// (#1064 — the chokepoint now accepts the navigation fields directly, so
// this probe matches the same code path every real producer hits).
const ns = 'smoke-1053';
const keys = ['chunk-smoke-foo-0', 'chunk-smoke-foo-1', 'chunk-smoke-foo-2'];
const meta = (i, total) => ({
  type: 'chunk',
  parentDoc: 'doc-smoke-foo',
  parentPath: '/foo.md',
  chunkIndex: i,
  totalChunks: total,
  prevChunk: i > 0 ? keys[i - 1] : null,
  nextChunk: i < total - 1 ? keys[i + 1] : null,
  siblings: keys,
  hierarchicalParent: null,
  hierarchicalChildren: null,
  chunkTitle: \`Chunk \${i}\`,
  headerLevel: 2,
  docContentHash: 'smoke-1053-hash',
});

// memory_store resolves the DB path itself; just make sure the directory
// is in place so a freshly-initialised consumer can write the first row.
mkdirSync('.moflo', { recursive: true });
const dbPath = '.moflo/moflo.db';
if (!existsSync(dbPath)) {
  console.log(JSON.stringify({ ok: false, reason: \`memory.db not at \${dbPath}\` }));
  process.exit(0);
}

for (let i = 0; i < keys.length; i++) {
  const out = await store.handler({
    key: keys[i],
    value: \`chunk body \${i}\`,
    namespace: ns,
    metadata: meta(i, keys.length),
  });
  if (!out || out.success !== true) {
    console.log(JSON.stringify({ ok: false, reason: 'seed failed', chunk: keys[i], error: out && out.error }));
    process.exit(0);
  }
}

const result = await neighbors.handler({ key: 'chunk-smoke-foo-1', namespace: ns });

// Cleanup so the smoke fixture doesn't leak rows into other checks.
for (const k of keys) {
  try { await del.handler({ key: k, namespace: ns }); } catch { /* ok */ }
}

console.log(JSON.stringify({
  ok: result.success === true,
  total: result.total,
  keys: (result.neighbors || []).map(n => n.key).sort(),
  hasNavigation: (result.neighbors || []).length > 0
    && (result.neighbors || []).every(n => n.navigation && typeof n.navigation === 'object'),
  // Per-neighbor diagnostic — a future regression surfaces *which* neighbor
  // is missing nav, not just "some neighbor is missing nav" (#1067 lesson).
  neighborDiag: (result.neighbors || []).map(n => ({
    key: n.key,
    hasNav: !!(n.navigation && typeof n.navigation === 'object'),
  })),
  error: result.error || null,
}));
`);

  const r = runNode(probe, [], { cwd: consumerDir, timeout: 60_000, env: { MOFLO_BRIDGE_QUIET: '1' } });
  if (r.code !== 0) {
    record('memory-protocol:get-neighbors', 'fail',
      `probe exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return;
  }

  let parsed;
  try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {
    record('memory-protocol:get-neighbors', 'fail', `probe stdout not JSON: ${r.stdout.trim().slice(0, 200)}`);
    return;
  }

  if (!parsed.ok) {
    record('memory-protocol:get-neighbors', 'fail',
      `handler returned success=false: ${parsed.error || 'unknown'} (raw: ${JSON.stringify(parsed)})`);
    return;
  }
  const expectedKeys = ['chunk-smoke-foo-0', 'chunk-smoke-foo-2'];
  if (parsed.total !== 2 || JSON.stringify(parsed.keys) !== JSON.stringify(expectedKeys)) {
    record('memory-protocol:get-neighbors', 'fail',
      `expected 2 neighbors ${JSON.stringify(expectedKeys)}, got ${parsed.total} ${JSON.stringify(parsed.keys)}`);
    return;
  }
  if (!parsed.hasNavigation) {
    record('memory-protocol:get-neighbors', 'fail',
      `returned neighbors without navigation field (S1 passthrough broken); diag=${JSON.stringify(parsed.neighborDiag)}`);
    return;
  }
  record('memory-protocol:get-neighbors', 'pass', '2 neighbors with navigation, shape matches memory_retrieve');
}

/**
 * Probe the bridge itself — asserts it actually initializes, not just that
 * moflodb_* tools are registered (the MCP tool list check above is theatre
 * on its own; the whole subsystem can be non-functional while listed).
 */
export function moflodbBridge(consumerDir) {
  section('MofloDb bridge health');
  const probe = join(consumerDir, 'moflodb-bridge-probe.mjs');
  const bridgePath = join(consumerDir, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'memory', 'memory-bridge.js')
    .replace(/\\/g, '/');
  writeFileSync(probe, `
import { pathToFileURL } from 'node:url';
const bridge = await import(pathToFileURL(${JSON.stringify(bridgePath)}).href);
const health = await bridge.bridgeHealthCheck();
const controllers = await bridge.bridgeListControllers();
console.log(JSON.stringify({
  available: !!health?.available,
  controllerCount: Array.isArray(controllers) ? controllers.length : 0,
  controllerNames: Array.isArray(controllers) ? controllers.map(c => c.name) : [],
  required: Array.isArray(bridge.REQUIRED_BRIDGE_CONTROLLERS) ? [...bridge.REQUIRED_BRIDGE_CONTROLLERS] : [],
  attestationCount: health?.attestationCount ?? null,
  hasCacheStats: !!health?.cacheStats,
}));
`);

  const r = runNode(probe, [], { cwd: consumerDir, timeout: 60_000, env: { MOFLO_BRIDGE_QUIET: '1' } });
  if (r.code !== 0) {
    record('moflodb-bridge', 'fail', `probe exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return;
  }

  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); } catch {
    record('moflodb-bridge', 'fail', `probe stdout not JSON: ${r.stdout.trim().slice(0, 200)}`);
    return;
  }

  if (!parsed.available) {
    record('moflodb-bridge:available', 'fail', 'bridgeHealthCheck returned available=false');
    return;
  }
  record('moflodb-bridge:available', 'pass');

  const required = parsed.required.length > 0
    ? parsed.required
    : ['hierarchicalMemory', 'tieredCache', 'memoryConsolidation', 'memoryGraph'];
  const missing = required.filter(n => !parsed.controllerNames.includes(n));
  if (missing.length > 0) {
    record('moflodb-bridge:controllers', 'fail', `missing required controllers: ${missing.join(', ')}`);
  } else {
    record('moflodb-bridge:controllers', 'pass', `${parsed.controllerCount} loaded (${required.length} required present)`);
  }
}

export function floSearch(consumerDir) {
  section('flo-search CLI');
  const bin = join(consumerDir, 'node_modules', 'moflo', 'bin', 'semantic-search.mjs');
  // Run with a harmless real query against the empty DB; expect graceful
  // exit (0 with "no results" output, or 1 with a clear error). We're
  // validating the binary loads and its deps resolve, not search quality.
  const r = runNode(bin, ['smoke-test-no-results', '--limit', '1'], {
    cwd: consumerDir,
    timeout: 60_000,
  });
  const loaded = /semantic-search/i.test(r.stdout + r.stderr);
  if (!loaded) {
    record('flo-search', 'fail', `binary did not load: exit ${r.code}`);
    return;
  }
  record('flo-search', 'pass', `exit ${r.code}`);
}

export function hooks(consumerDir) {
  section('Hooks surface');
  recordExit('hooks-list', flo(consumerDir, ['hooks', 'list']));
  recordExit('hooks-pre-task',
    flo(consumerDir, ['hooks', 'pre-task', '--task-id', 'smoke-1', '--description', 'smoke task']));

  const dummy = join(consumerDir, 'dummy.txt');
  writeFileSync(dummy, 'smoke');
  // post-edit learning may warn (exit 1) but should not crash.
  recordExit('hooks-post-edit',
    flo(consumerDir, ['hooks', 'post-edit', '--file', dummy]), { okCodes: [0, 1] });
}

export function floSkillPackaged(consumerDir) {
  section('/flo skill packaging');
  const skill = join(consumerDir, 'node_modules', 'moflo', '.claude', 'skills', 'fl', 'SKILL.md');
  if (!existsSync(skill)) {
    record('flo-skill', 'fail', `${relative(consumerDir, skill)} missing`);
    return;
  }
  const content = readFileSync(skill, 'utf8');
  if (!/\/flo/.test(content)) {
    record('flo-skill', 'fail', 'SKILL.md present but missing /flo reference');
    return;
  }
  record('flo-skill', 'pass', relative(consumerDir, skill));
}

/**
 * Every shipped `.claude/skills/<name>/SKILL.md` whose frontmatter has an
 * `arguments:` field must be safe to load by Claude Code's slash-command
 * harness. The harness compiles that field as a JS regex; any `[...]`
 * segment containing a hyphen between alphabetically-descending letters
 * (e.g. `[topic-or-path]` → `r-p`, `[spell-name-or-alias]` → `n-a`)
 * raises `SyntaxError: Range out of order in character class` and the
 * skill never loads.
 *
 * Both bugs shipped — guidance/SKILL.md and spell-schedule/SKILL.md —
 * before this check existed. Any regression now fails the smoke run.
 */
export function verifyShippedSkillArguments(consumerDir) {
  section('Shipped SKILL.md `arguments:` field is regex-safe');
  const skillsDir = join(consumerDir, 'node_modules', 'moflo', '.claude', 'skills');
  if (!existsSync(skillsDir)) {
    record('skill-arguments-regex-safe', 'fail', '.claude/skills/ missing in installed moflo');
    return;
  }

  const offenders = [];
  let scanned = 0;
  for (const skillFile of walkSkillFiles(skillsDir)) {
    scanned++;
    let text;
    try { text = readFileSync(skillFile, 'utf8'); }
    catch { continue; }
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const argLine = fm.split(/\r?\n/).find(l => /^arguments:/.test(l));
    if (!argLine) continue;
    const value = argLine.replace(/^arguments:\s*/, '').replace(/^['"]|['"]$/g, '');
    const classes = value.match(/\[[^\]]*\]/g) || [];
    for (const cls of classes) {
      try { new RegExp(cls); }
      catch (err) {
        offenders.push({
          file: relative(consumerDir, skillFile),
          segment: cls,
          error: err.message.replace(/^Invalid regular expression: /, ''),
        });
      }
    }
  }

  if (offenders.length > 0) {
    const preview = offenders.slice(0, 3)
      .map(o => `${o.file} → \`${o.segment}\` (${o.error})`)
      .join(' | ');
    const suffix = offenders.length > 3 ? ` (+${offenders.length - 3} more)` : '';
    record('skill-arguments-regex-safe', 'fail',
      `${offenders.length} SKILL.md(s) with regex-poison \`arguments:\` field — ${preview}${suffix}`);
    return;
  }
  record('skill-arguments-regex-safe', 'pass', `${scanned} SKILL.md(s) scanned, all clean`);
}

function* walkSkillFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { yield* walkSkillFiles(full); continue; }
    if (entry.isFile() && entry.name === 'SKILL.md') yield full;
  }
}

export function consumerInvariants(consumerDir) {
  section('Consumer invariants');

  const stray = readdirSync(consumerDir).filter(name => {
    if (name === 'node_modules') return false;
    const full = join(consumerDir, name);
    return statSync(full).isFile() && name.endsWith('.rvf');
  });
  record('no-stray-rvf', stray.length === 0 ? 'pass' : 'fail',
    stray.length ? stray.join(', ') : 'clean');

  const agentdbRvf = join(consumerDir, 'agentdb.rvf');
  const agentdbRvfPresent = existsSync(agentdbRvf);
  record('no-agentdb-rvf', agentdbRvfPresent ? 'fail' : 'pass',
    agentdbRvfPresent ? 'found at consumer root' : 'clean');

  const swarmDir = join(consumerDir, '.swarm');
  if (existsSync(swarmDir)) {
    record('.swarm-contents', 'info', readdirSync(swarmDir).join(', ') || 'empty');
  } else {
    record('.swarm-not-created', 'info', 'no .swarm/ in consumer root');
  }
}

// Re-baselined for ORT 1.24.3 + transitive growth (issue #1011, re-anchored
// May 2026): macOS consumer install measured at 130 MB, Windows at 97 MB,
// Linux at 90 MB. Anchor to macOS so the cap stays meaningful on every
// platform; same headroom math as #1011 (+9% warn, +22% fail) for room to
// absorb the next ORT minor without ratcheting every release. Prior pair
// was 125/140 against an older 115 MB macOS baseline — current macOS sits
// at the warn line on every smoke run, drowning real signal in noise.
// Override via MOFLO_INSTALL_SIZE_{WARN,MAX}_MB (see harness README).
const INSTALL_SIZE_WARN_MB_DEFAULT = 140;
const INSTALL_SIZE_MAX_MB_DEFAULT = 160;

function readEnvMb(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function installSurface(consumerDir) {
  section('Install surface');
  const mofloDir = join(consumerDir, 'node_modules', 'moflo');
  if (!existsSync(mofloDir)) {
    record('install-surface', 'fail', 'node_modules/moflo missing');
    return;
  }
  const nodeModulesDir = join(consumerDir, 'node_modules');
  const totalMb = folderSize(nodeModulesDir) / 1024 / 1024;
  const mofloMb = folderSize(mofloDir) / 1024 / 1024;
  const maxMb = readEnvMb('MOFLO_INSTALL_SIZE_MAX_MB', INSTALL_SIZE_MAX_MB_DEFAULT);
  // Clamp warn to max so a user who raises MAX alone still gets a sensible
  // warn ceiling instead of a nonsensical "warn > 200, fail > 120" print.
  const warnMb = Math.min(
    readEnvMb('MOFLO_INSTALL_SIZE_WARN_MB', INSTALL_SIZE_WARN_MB_DEFAULT),
    maxMb,
  );
  const detail =
    `${totalMb.toFixed(1)} MB total` +
    ` (moflo pkg ${mofloMb.toFixed(1)} MB;` +
    ` warn > ${warnMb} MB, fail > ${maxMb} MB)`;
  if (totalMb > maxMb) {
    record('moflo-install-size', 'fail', detail);
    logTopOffenders(nodeModulesDir);
  } else if (totalMb > warnMb) {
    record('moflo-install-size', 'warn', detail);
    logTopOffenders(nodeModulesDir);
  } else {
    record('moflo-install-size', 'pass', detail);
  }
}

/**
 * Print the top-10 largest direct children of node_modules so a budget
 * failure is actionable without another CI round-trip. Scope resolution
 * (e.g. `@anush008/*`) is flattened so scoped subpackages surface on their
 * own rather than hiding inside a scope total.
 */
function logTopOffenders(nodeModulesDir) {
  const children = [];
  for (const name of readdirSync(nodeModulesDir)) {
    const full = join(nodeModulesDir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (!s.isDirectory()) continue;
    if (name.startsWith('@')) {
      for (const sub of readdirSync(full)) {
        const subFull = join(full, sub);
        try {
          if (!statSync(subFull).isDirectory()) continue;
        } catch { continue; }
        children.push({ name: `${name}/${sub}`, size: folderSize(subFull) });
      }
    } else {
      children.push({ name, size: folderSize(full) });
    }
  }
  children.sort((a, b) => b.size - a.size);
  log('  top offenders:');
  for (const c of children.slice(0, 10)) {
    log(`    ${(c.size / 1024 / 1024).toFixed(1).padStart(6)} MB  ${c.name}`);
  }
}

/**
 * Inspect one onnxruntime-node install; return a problem string or null.
 *
 * ORT names this directory after the N-API ABI it was built against — `napi-v3`
 * in 1.21, `napi-v6` in 1.24+ — so we discover whichever subdir(s) the install
 * actually ships (via the same helper the pruner uses) and assert each one is
 * pruned to the current platform/arch.
 */
function inspectOrtInstall(ortDir, consumerDir) {
  const napiDirs = listNapiDirs(join(ortDir, 'bin'));
  if (napiDirs.length === 0) return null; // future layout change, not a prune failure

  const rel = relative(consumerDir, ortDir);
  const dirNames = (d) => readdirSync(d, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const napi of napiDirs) {
    const napiName = basename(napi);
    const platforms = dirNames(napi);
    const platExtras = platforms.filter(p => p !== process.platform);
    if (platExtras.length > 0) return `${rel}: extra platforms in ${napiName} — ${platExtras.join(', ')}`;
    if (!platforms.includes(process.platform)) return `${rel}: current platform dir missing in ${napiName} (${process.platform})`;

    const archs = dirNames(join(napi, process.platform));
    const archExtras = archs.filter(a => a !== process.arch);
    if (archExtras.length > 0) return `${rel}: extra archs under ${napiName}/${process.platform} — ${archExtras.join(', ')}`;
    if (!archs.includes(process.arch)) return `${rel}: current arch dir missing in ${napiName}/${process.platform} (${process.arch})`;
  }
  return null;
}

/**
 * After postinstall, every onnxruntime-node install should retain only the
 * current `<platform>/<arch>` subtree under each `bin/napi-v<N>/` directory.
 * Hard-fail on any non-current platform directory or any extra arch under the
 * kept platform.
 */
export function verifyPrunedBinaries(consumerDir) {
  section('Verify onnxruntime-node binaries pruned to current platform');
  const nm = join(consumerDir, 'node_modules');
  const ortInstalls = findOrtPackages(nm);

  if (ortInstalls.length === 0) {
    record('ort-pruned', 'info', 'no onnxruntime-node install found');
    return;
  }

  const problems = [];
  for (const ort of ortInstalls) {
    const p = inspectOrtInstall(ort, consumerDir);
    if (p) problems.push(p);
  }

  if (problems.length > 0) {
    record('ort-pruned', 'fail', `prune incomplete — ${problems.join(' | ')}`);
    return;
  }
  record('ort-pruned', 'pass', `${ortInstalls.length} install(s) pruned to ${process.platform}/${process.arch}`);
}

/**
 * `@anush008/tokenizers` ships its native binary via the sharp-style
 * optional-subpackage pattern. A healthy install has exactly one
 * `@anush008/tokenizers-<platform>-<arch>[-<abi>]` sibling — zero means npm's
 * optional-dep selection failed (broken install), multiple means something is
 * packaging too many variants.
 */
export function verifyTokenizerSubpackage(consumerDir) {
  section('Verify @anush008/tokenizers native subpackage');
  const scopeDir = join(consumerDir, 'node_modules', '@anush008');
  if (!existsSync(scopeDir)) {
    record('tokenizer-subpackage', 'fail', '@anush008/ scope missing — fastembed cannot tokenize');
    return;
  }
  let entries;
  try { entries = readdirSync(scopeDir); }
  catch (err) {
    record('tokenizer-subpackage', 'fail', `cannot read @anush008/: ${err.message}`);
    return;
  }
  const hasBase = entries.includes('tokenizers');
  const platformPkgs = entries.filter(n => /^tokenizers-/.test(n));
  if (!hasBase) {
    record('tokenizer-subpackage', 'fail', '@anush008/tokenizers base package missing');
    return;
  }
  if (platformPkgs.length === 0) {
    record('tokenizer-subpackage', 'fail', 'no @anush008/tokenizers-<platform> subpackage installed (optional-dep selection failed)');
    return;
  }
  if (platformPkgs.length > 1) {
    record('tokenizer-subpackage', 'fail', `expected exactly one platform subpackage, found ${platformPkgs.length}: ${platformPkgs.join(', ')}`);
    return;
  }
  record('tokenizer-subpackage', 'pass', `@anush008/${platformPkgs[0]} present`);
}

function folderSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch (err) {
      log(`  folderSize: cannot stat ${full}: ${err.message}`);
      continue;
    }
    if (s.isDirectory()) total += folderSize(full);
    else total += s.size;
  }
  return total;
}

/**
 * Issue #575: scan captured stderr from every subprocess for `Cannot find
 * module` / `ENOENT` lines — exit-zero commands can still emit those from
 * optional dynamic imports, hiding the path regressions this audit guards.
 */
export function verifyNoPathResolutionErrors() {
  section('Path resolution stderr scan (issue #575)');
  const samples = getStderrSamples();
  const offenders = [];

  const CANNOT_FIND_RE = /Cannot find module ['"]([^'"]+)['"]/g;
  const ENOENT_RE = /ENOENT[^\n]*['"]([^'"]+\.(?:js|mjs|cjs|ts|json))['"]/g;

  for (const { label, stderr } of samples) {
    let m;
    CANNOT_FIND_RE.lastIndex = 0;
    while ((m = CANNOT_FIND_RE.exec(stderr)) !== null) {
      offenders.push({ label, kind: 'cannot-find-module', target: m[1] });
    }
    ENOENT_RE.lastIndex = 0;
    while ((m = ENOENT_RE.exec(stderr)) !== null) {
      offenders.push({ label, kind: 'enoent', target: m[1] });
    }
  }

  if (offenders.length === 0) {
    record('path-resolution-stderr', 'pass', `${samples.length} subprocess(es) clean`);
    return;
  }

  const byTarget = new Map();
  for (const o of offenders) {
    if (!byTarget.has(o.target)) byTarget.set(o.target, []);
    byTarget.get(o.target).push(`${o.label}(${o.kind})`);
  }
  for (const [target, sites] of byTarget) {
    record(
      `path-resolution:${target.slice(0, 80)}`,
      'fail',
      `seen in: ${[...new Set(sites)].slice(0, 4).join(', ')}`,
    );
  }
}

/**
 * Issue #585: probe every `@moflo/*` bare-specifier path in the consumer
 * install. Catches the regression class that shipped in 4.8.87-rc.2 — silent
 * `try/catch { return null }` blocks around `import('@moflo/<pkg>')` that hid
 * a broken tarball from consumers.
 *
 * Delegates to `scripts/consumer-smoke/probe-bare-specifiers.mjs` so
 * contributors can reproduce locally with one command:
 *   node scripts/consumer-smoke/probe-bare-specifiers.mjs --consumer-dir <path>
 */
export function consumerInstallSensitivePaths(consumerDir, repoRoot) {
  section('Consumer-install-sensitive @moflo/* probes (issue #585)');
  const probe = join(repoRoot, 'scripts', 'consumer-smoke', 'probe-bare-specifiers.mjs');
  if (!existsSync(probe)) {
    record('probe-bare-specifiers', 'fail', `${relative(repoRoot, probe)} missing`);
    return;
  }
  const r = runNode(probe, ['--consumer-dir', consumerDir, '--json'], {
    cwd: repoRoot,
    timeout: 180_000,
  });
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); } catch {
    record('probe-bare-specifiers', 'fail',
      `non-JSON output (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return;
  }
  for (const pr of parsed.results) {
    record(`probe:${pr.name}`, pr.status, pr.detail);
  }
  if (r.code !== 0 && parsed.hardFails === 0) {
    // Probe exit was non-zero but no hard fails were recorded — surface so
    // the harness doesn't silently miss an aborted probe run.
    record('probe-bare-specifiers', 'fail', `probe exit ${r.code} with no recorded fails`);
  }
}

export function stopConsumerDaemon(consumerDir) {
  // Consumer scratch dirs have no moflo.yaml, so the daemon auto-starts
  // during memory ops and holds locks on .swarm/memory.db. Stop it so the
  // tmpdir can actually be removed on Windows.
  try {
    flo(consumerDir, ['daemon', 'stop'], { timeout: 15_000 });
  } catch (err) {
    log(`  stopConsumerDaemon(${consumerDir}) failed: ${err.message}`);
  }
}

// session-start-launcher.mjs spawns build-embeddings.mjs, index-all.mjs, and
// the daemon as detached background children inside the consumer. They are
// registered in <consumer>/.moflo/background-pids.json by ProcessManager.
// Without draining that registry the harness's `rm -rf` races live processes
// holding files open — produces orphan node procs (88% CPU, 2 GB RAM) and
// EPERM cleanup failures. Reuses the same killAll() the session-end hook runs.
export async function killConsumerBackgroundProcesses(consumerDir) {
  const pmPath = join(consumerDir, 'node_modules', 'moflo', 'bin', 'lib', 'process-manager.mjs');
  if (!existsSync(pmPath)) return;
  try {
    const mod = await import(pathToFileURL(pmPath).href);
    const pm = mod.createProcessManager(consumerDir);
    const result = pm.killAll();
    if (result && result.killed > 0) {
      log(`  killed ${result.killed} background process(es) in ${basename(consumerDir)}`);
    }
  } catch (err) {
    log(`  killConsumerBackgroundProcesses(${basename(consumerDir)}) failed: ${err.message}`);
  }
}

// Belt-and-suspenders: the auto-start daemon path in src/cli/index.ts spawns
// `daemon start --foreground --quiet` via raw spawn() and never registers
// the PID with ProcessManager. flo daemon stop reaches it via lock holder
// most of the time, but a daemon spawned during a late check may not have
// acquired the lock by the time stopConsumerDaemon ran. Read the lock file
// directly and kill the process tree as a final pass.
function killDaemonByLockFile(consumerDir) {
  const lockFile = join(consumerDir, '.moflo', 'daemon.lock');
  if (!existsSync(lockFile)) return 0;
  let pid = null;
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf-8'));
    if (typeof parsed?.pid === 'number' && parsed.pid > 0) pid = parsed.pid;
  } catch { /* malformed lock — nothing to kill */ }
  if (!pid) return 0;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    log(`  killed orphan daemon PID ${pid} (lock file) in ${basename(consumerDir)}`);
    return 1;
  } catch {
    return 0;
  }
}

/**
 * #1018: After cleanupWorkDir's 2.5s retry budget, a Windows EBUSY on rmSync
 * is a known platform quirk — AV scans, Windows indexer, and OS handle
 * release latency can keep the dir locked past our patience. CI runners are
 * ephemeral and the next run uses a fresh `consumer-<timestamp>` dir, so the
 * leftover dir doesn't poison subsequent tests. The warning was pure log
 * noise. Other failures (EPERM, EACCES, ENOENT, *anything* on POSIX) are
 * still real signals worth surfacing.
 *
 * Matches against `err.code` (the canonical, locale-proof Node SystemError
 * field) rather than the human-readable `err.message` text.
 *
 * Exported so the classifier can be unit-tested without standing up a real
 * workdir + daemon. `platform` is a parameter so tests can exercise the
 * POSIX branch on Windows hosts and vice-versa.
 */
export function isKnownWindowsCleanupQuirk(err, platform) {
  return platform === 'win32' && err?.code === 'EBUSY';
}

export async function cleanupWorkDir(workDir, { keep }) {
  if (keep) {
    log(`\nKept: ${workDir}`);
    return;
  }
  if (!existsSync(workDir)) return;
  for (const name of readdirSync(workDir)) {
    if (!name.startsWith('consumer-')) continue;
    const full = join(workDir, name);
    stopConsumerDaemon(full);
    await killConsumerBackgroundProcesses(full);
    killDaemonByLockFile(full);
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      if (!isKnownWindowsCleanupQuirk(err, process.platform)) {
        log(`  warning: could not remove ${name}: ${err.message}`);
      }
    }
  }
}
