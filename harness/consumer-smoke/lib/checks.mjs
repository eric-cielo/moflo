/**
 * Smoke-harness checks. Each check records pass/fail/warn/info via the
 * reporter; none throw on a soft fail. Abort-on-hard-error (pack/install
 * prerequisites) is handled by the caller via re-thrown errors.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

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
    const match = text.match(bannedRe);
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

export function doctor(consumerDir) {
  section('Doctor');
  // doctor exits 1 on warnings; both 0 and 1 are acceptable runs.
  const r = flo(consumerDir, ['doctor', '--json'], { timeout: 60_000 });
  recordExit('doctor', r, { okCodes: [0, 1] });
}

export function memoryInit(consumerDir) {
  section('Memory initialization');
  const r = flo(consumerDir, ['memory', 'init'], { timeout: 120_000 });
  if (!recordExit('memory-init', r)) throw new Error('memory init failed');
}

export function memoryCrud(consumerDir) {
  section('Memory CRUD round-trip');
  const key = `smoke-${Date.now()}`;
  const value = 'smoke-harness-sentinel';

  recordExit('memory-store', flo(consumerDir, ['memory', 'store', '-k', key, '-v', value, '--namespace', 'smoke']));

  const get = flo(consumerDir, ['memory', 'retrieve', '-k', key, '--namespace', 'smoke']);
  const ok = get.code === 0 && get.stdout.includes(value);
  record('memory-retrieve', ok ? 'pass' : 'fail',
    ok ? 'value round-trips' : `exit ${get.code}, value missing from output`);

  recordExit('memory-search', flo(consumerDir, ['memory', 'search', '-q', 'smoke', '--namespace', 'smoke', '--limit', '5']));

  recordExit('memory-list', flo(consumerDir, ['memory', 'list', '--namespace', 'smoke']));

  recordExit('memory-delete', flo(consumerDir, ['memory', 'delete', '-k', key, '--namespace', 'smoke']));
}

export function spellList(consumerDir) {
  section('Spell engine');
  // spell list may exit 1 if no spells are registered yet; either is acceptable.
  recordExit('spell-list', flo(consumerDir, ['spell', 'list'], { timeout: 60_000 }), { okCodes: [0, 1] });
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
}

/**
 * Probe the bridge itself — asserts it actually initializes, not just that
 * moflodb_* tools are registered (the MCP tool list check above is theatre
 * on its own; the whole subsystem can be non-functional while listed).
 */
export function moflodbBridge(consumerDir) {
  section('MofloDb bridge health');
  const probe = join(consumerDir, 'moflodb-bridge-probe.mjs');
  const bridgePath = join(consumerDir, 'node_modules', 'moflo', 'src', 'modules', 'cli', 'dist', 'src', 'memory', 'memory-bridge.js')
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

// Defaults headroom over the README's ~80 MB post-prune claim.
// Override via MOFLO_INSTALL_SIZE_{WARN,MAX}_MB (see harness README).
const INSTALL_SIZE_WARN_MB_DEFAULT = 100;
const INSTALL_SIZE_MAX_MB_DEFAULT = 120;

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

export function cleanupWorkDir(workDir, { keep }) {
  if (keep) {
    log(`\nKept: ${workDir}`);
    return;
  }
  if (!existsSync(workDir)) return;
  for (const name of readdirSync(workDir)) {
    if (!name.startsWith('consumer-')) continue;
    const full = join(workDir, name);
    stopConsumerDaemon(full);
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      log(`  warning: could not remove ${name}: ${err.message}`);
    }
  }
}
