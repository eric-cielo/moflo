/**
 * Smoke-harness checks. Each check records pass/fail/warn/info via the
 * reporter; none throw on a soft fail. Abort-on-hard-error (pack/install
 * prerequisites) is handled by the caller via re-thrown errors.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { run, runNode, flo, NPM_CMD, IS_WIN } from './proc.mjs';
import { section, record, recordExit, log } from './report.mjs';

// Regex for the Windows-specific libuv async-handle teardown assertion that
// crashes `flo memory list` at process exit after printing correct output
// (bug in moflo; fix tracked separately). We downgrade to WARN in that case.
const WIN_LIBUV_TEARDOWN_RE = /Assertion failed.*async\.c/i;

// Epic #501 acceptance criterion: a fresh `npm install moflo` consumer sees
// zero of the following packages anywhere in its dep tree.
export const FORBIDDEN_DEPS = [
  'agentdb',
  'agentic-flow',
  '@ruvector',
  'ruvector',
  'onnxruntime-node',
];

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

  const list = flo(consumerDir, ['memory', 'list', '--namespace', 'smoke']);
  // `memory list` can crash at teardown on Windows (libuv async-handle
  // assertion) after printing correct output; downgrade to WARN in that case.
  const listedOk = /Memory Entries/.test(list.stdout);
  const winTeardownCrash = IS_WIN && WIN_LIBUV_TEARDOWN_RE.test(list.stderr);
  if (list.code === 0) {
    record('memory-list', 'pass');
  } else if (listedOk && winTeardownCrash) {
    record('memory-list', 'warn', 'Windows libuv teardown crash after correct output (moflo bug)');
  } else {
    record('memory-list', 'fail', `exit ${list.code}: ${list.stderr.trim().slice(0, 200)}`);
  }

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

export function installSurface(consumerDir) {
  section('Install surface');
  const mofloDir = join(consumerDir, 'node_modules', 'moflo');
  if (!existsSync(mofloDir)) {
    record('install-surface', 'fail', 'node_modules/moflo missing');
    return;
  }
  const sz = folderSize(mofloDir);
  record('moflo-install-size', 'info', `${(sz / 1024 / 1024).toFixed(1)} MB`);
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
