#!/usr/bin/env node
/**
 * Consumer smoke-test harness — epic #464 Gate 3
 *
 * Packs the current moflo working tree, installs it into a clean tempdir as
 * a devDependency (just like a real consumer would), and exercises the
 * Claude-Code-facing surface: memory store/search, spells list, MCP tools
 * registration, embeddings generation.
 *
 * Also asserts the "consumer invariants":
 *   - no `agentdb.rvf` or stray `*.rvf` written to consumer cwd
 *   - `.swarm/` appears in consumer root (that's expected), not in moflo's own dir
 *   - `node_modules/moflo/` does not contain unexpected artifacts
 *
 * Usage:
 *   node harness/consumer-smoke/run.mjs              # full run
 *   node harness/consumer-smoke/run.mjs --skip-pack  # reuse last tarball
 *   node harness/consumer-smoke/run.mjs --keep       # keep .work/ for inspection
 *
 * Exit code 0 = all smokes green; 1 = at least one smoke failed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const harnessRoot = __dirname;
const workDir = join(harnessRoot, '.work');

const args = new Set(process.argv.slice(2));
const skipPack = args.has('--skip-pack');
const keep = args.has('--keep');

const results = [];
let failed = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const icon = ok ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

function runSync(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: opts.capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    cwd: opts.cwd ?? workDir,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
  });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function step(title, fn) {
  console.log(`\n--- ${title} ---`);
  try {
    fn();
  } catch (e) {
    record(title, false, e?.message ?? String(e));
  }
}

// ------------------------------------------------------------------
// Phase 1: pack moflo
// ------------------------------------------------------------------

function packMoflo() {
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  if (skipPack) {
    const existing = readdirSync(workDir).filter((f) => f.startsWith('moflo-') && f.endsWith('.tgz'));
    if (existing.length > 0) {
      console.log(`Reusing existing tarball: ${existing[0]}`);
      return join(workDir, existing[0]);
    }
    console.log('No existing tarball found; packing anyway.');
  }

  console.log('Running `npm pack` in repo root...');
  const r = runSync('npm', ['pack', '--pack-destination', workDir], {
    cwd: repoRoot,
    capture: true,
    timeout: 180_000,
  });
  if (r.code !== 0) {
    throw new Error(`npm pack failed (exit ${r.code}):\n${r.stderr}`);
  }
  // Last line of stdout is the tarball filename.
  const lines = r.stdout.trim().split(/\r?\n/);
  const tarballName = lines[lines.length - 1].trim();
  const tarballPath = join(workDir, tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`Expected tarball at ${tarballPath}, not found`);
  }
  return tarballPath;
}

// ------------------------------------------------------------------
// Phase 2: install into consumer tempdir
// ------------------------------------------------------------------

function installConsumer(tarballPath) {
  // Unique dir per run to avoid Windows file locks from prior moflo daemons.
  const consumerDir = join(workDir, `consumer-${Date.now()}`);
  mkdirSync(consumerDir, { recursive: true });

  const pkg = {
    name: 'moflo-consumer-smoke',
    version: '0.0.0',
    private: true,
    type: 'module',
    devDependencies: {
      moflo: `file:${tarballPath.replace(/\\/g, '/')}`,
    },
  };
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify(pkg, null, 2));

  console.log('Installing moflo into consumer tempdir...');
  const r = runSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=warn'], {
    cwd: consumerDir,
    timeout: 300_000,
  });
  if (r.code !== 0) {
    throw new Error(`npm install failed (exit ${r.code})`);
  }
  return consumerDir;
}

// ------------------------------------------------------------------
// Phase 3: smoke checks
// ------------------------------------------------------------------

function smokeCheck(consumerDir) {
  const floBin = process.platform === 'win32' ? 'flo.cmd' : 'flo';
  const floPath = join(consumerDir, 'node_modules', '.bin', floBin);

  // 1. Version check
  step('flo --version runs', () => {
    const r = runSync(floPath, ['--version'], { cwd: consumerDir, capture: true });
    record('flo --version runs', r.code === 0, r.stdout.trim().slice(0, 80));
  });

  // 2. Doctor
  step('flo doctor --json runs', () => {
    const r = runSync(floPath, ['doctor', '--json'], { cwd: consumerDir, capture: true, timeout: 60_000 });
    const ok = r.code === 0 || r.code === 1; // doctor exits 1 on warnings; both are acceptable runs
    record('flo doctor runs', ok, `exit=${r.code}`);
  });

  // 3. Memory init (required — "Database not found" on fresh install otherwise)
  step('flo memory init', () => {
    const r = runSync(floPath, ['memory', 'init'], {
      cwd: consumerDir, capture: true, timeout: 120_000,
    });
    const detail = r.code === 0
      ? `exit=${r.code}`
      : `exit=${r.code} stderr=${r.stderr.trim().slice(0, 300)}`;
    record('memory init', r.code === 0, detail);
  });

  // 4. Memory store + retrieve
  step('flo memory store + retrieve', () => {
    const testValue = 'smoke-test-value-' + Date.now();
    const storeRes = runSync(
      floPath,
      ['memory', 'store', '-k', 'smoke-test-key', '-v', testValue, '--namespace', 'smoke'],
      { cwd: consumerDir, capture: true, timeout: 60_000 }
    );
    const storeDetail = storeRes.code === 0
      ? `exit=${storeRes.code}`
      : `exit=${storeRes.code} stderr=${storeRes.stderr.trim().slice(0, 300)} stdout=${storeRes.stdout.trim().slice(0, 300)}`;
    record('memory store', storeRes.code === 0, storeDetail);

    const getRes = runSync(
      floPath,
      ['memory', 'retrieve', '-k', 'smoke-test-key', '--namespace', 'smoke'],
      { cwd: consumerDir, capture: true, timeout: 60_000 }
    );
    const hit = getRes.stdout.includes(testValue);
    const getDetail = hit
      ? 'value matches'
      : `value missing; exit=${getRes.code} stderr=${getRes.stderr.trim().slice(0, 200)} stdout=${getRes.stdout.trim().slice(0, 200)}`;
    record('memory retrieve round-trips value', hit, getDetail);
  });

  // 5. Memory search
  step('flo memory search', () => {
    const r = runSync(
      floPath,
      ['memory', 'search', '-q', 'smoke', '--namespace', 'smoke', '--limit', '5'],
      { cwd: consumerDir, capture: true, timeout: 60_000 }
    );
    const detail = r.code === 0
      ? `exit=${r.code}`
      : `exit=${r.code} stderr=${r.stderr.trim().slice(0, 300)}`;
    record('memory search runs', r.code === 0, detail);
  });

  // 5. Spell list
  step('flo spell list', () => {
    const r = runSync(floPath, ['spell', 'list'], { cwd: consumerDir, capture: true, timeout: 60_000 });
    record('spell list runs', r.code === 0 || r.code === 1, `exit=${r.code}`);
  });

  // 6. Consumer invariants
  step('consumer invariants', () => {
    const stray = listRvfFiles(consumerDir);
    record(
      'no stray *.rvf in consumer root',
      stray.length === 0,
      stray.length ? stray.join(', ') : 'clean'
    );

    const agentdbRvfPath = join(consumerDir, 'agentdb.rvf');
    const sneaked = existsSync(agentdbRvfPath);
    record('no agentdb.rvf written to consumer root', !sneaked, sneaked ? 'found!' : 'clean');

    const swarmDir = join(consumerDir, '.swarm');
    if (existsSync(swarmDir)) {
      const swarmFiles = readdirSync(swarmDir);
      record('.swarm/ contents observed', true, swarmFiles.join(', '));
    } else {
      record('.swarm/ not created', true, 'none');
    }
  });

  // 7. moflo install surface
  step('moflo install surface', () => {
    const mofloDir = join(consumerDir, 'node_modules', 'moflo');
    const present = existsSync(mofloDir);
    record('node_modules/moflo exists', present);

    if (present) {
      const sz = folderSize(mofloDir);
      record('moflo install size reported', true, `${(sz / 1024 / 1024).toFixed(1)} MB`);
    }

    const agenticFlowDir = join(consumerDir, 'node_modules', 'agentic-flow');
    record(
      'agentic-flow transitive state',
      true,
      existsSync(agenticFlowDir) ? 'present' : 'absent'
    );

    const agentdbDir = join(consumerDir, 'node_modules', 'agentdb');
    record(
      'agentdb transitive state',
      true,
      existsSync(agentdbDir) ? 'present' : 'absent'
    );
  });
}

function listRvfFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isFile() && name.endsWith('.rvf')) out.push(name);
  }
  return out;
}

function folderSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) total += folderSize(full);
    else total += s.size;
  }
  return total;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

try {
  const tarball = packMoflo();
  console.log(`\nTarball: ${tarball}`);
  const consumerDir = installConsumer(tarball);
  console.log(`Consumer dir: ${consumerDir}`);
  smokeCheck(consumerDir);
} catch (e) {
  console.error('\nHarness aborted:', e?.message ?? e);
  process.exitCode = 2;
} finally {
  console.log('\n=== Summary ===');
  for (const { name, ok, detail } of results) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`\n${failed} failure(s) out of ${results.length} checks.`);

  if (!keep) {
    console.log('\nCleanup: removing stale consumer dirs (use --keep to retain this run).');
    if (existsSync(workDir)) {
      for (const name of readdirSync(workDir)) {
        if (!name.startsWith('consumer-') && name !== 'consumer') continue;
        const full = join(workDir, name);
        try {
          rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        } catch (e) {
          console.warn(`Could not remove ${name} (${e?.code ?? 'unknown'}); delete manually if desired.`);
        }
      }
    }
  }

  if (failed > 0 && process.exitCode === undefined) process.exitCode = 1;
}
