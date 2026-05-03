#!/usr/bin/env node
/**
 * Sequential indexer chain for session-start.
 *
 * Each step is gated independently — see `lib/index-fingerprint.mjs`. The
 * orchestrator just walks the plan, asks the gate per step, runs the
 * survivors, and saves the post-run fingerprint when each succeeds.
 *
 * Steps run sequentially (DB-writing) to avoid sql.js last-write-wins
 * concurrency issues (#78). HNSW rebuild is last, after every other step
 * has committed (#81).
 *
 * Spawned as a single detached background process by hooks.mjs session-start.
 */

import { existsSync, appendFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { platform } from 'os';
import { hnswIndexPath } from './lib/moflo-paths.mjs';
import {
  decideStepGate,
  computeStepFingerprint,
  saveStepFingerprint,
  cleanupLegacyFingerprint,
} from './lib/index-fingerprint.mjs';

// Cap fastembed/ONNX thread count when spawning the heavy steps. Without
// this, ONNX defaults to one thread per CPU core (22+ on a modern dev box),
// pegging the entire machine while the indexer runs. 2 threads keeps
// re-embedding throughput acceptable while leaving the box usable.
const ONNX_THREAD_CAP = {
  OMP_NUM_THREADS: '2',
  ONNXRUNTIME_INTRA_OP_NUM_THREADS: '2',
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect project root by walking up from cwd to find package.json.
// IMPORTANT: Do NOT use resolve(__dirname, '..') — this script lives in bin/
// during development but gets synced to .claude/scripts/ in consumer projects,
// so __dirname-relative paths break. findProjectRoot() works in both locations.
function findProjectRoot() {
  let dir = process.cwd();
  const root = resolve(dir, '/');
  while (dir !== root) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();
const LOG_PATH = resolve(projectRoot, '.swarm/hooks.log');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [index-all] ${msg}\n`;
  try { appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
}

function resolveBin(binName, localScript) {
  const mofloScript = resolve(projectRoot, 'node_modules/moflo/bin', localScript);
  if (existsSync(mofloScript)) return mofloScript;
  const npmBin = resolve(projectRoot, 'node_modules/.bin', binName);
  if (existsSync(npmBin)) return npmBin;
  const localPath = resolve(projectRoot, '.claude/scripts', localScript);
  if (existsSync(localPath)) return localPath;
  // Also check bin/ directory (for development use)
  const binPath = resolve(projectRoot, 'bin', localScript);
  if (existsSync(binPath)) return binPath;
  return null;
}

function getLocalCliPath() {
  const paths = [
    resolve(projectRoot, 'node_modules/moflo/bin/cli.js'),
    resolve(projectRoot, 'node_modules/.bin/flo'),
    // Development: local CLI
    resolve(projectRoot, 'bin/cli.js'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read moflo.yaml once and cache auto_index flags. */
let _autoIndexFlags = null;
function isIndexEnabled(key) {
  if (_autoIndexFlags === null) {
    _autoIndexFlags = {};
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    if (existsSync(yamlPath)) {
      try {
        const content = readFileSync(yamlPath, 'utf-8');
        for (const k of ['guidance', 'code_map', 'tests', 'patterns']) {
          const re = new RegExp(`auto_index:\\s*\\n(?:.*\\n)*?\\s+${k}:\\s*(true|false)`);
          const match = content.match(re);
          _autoIndexFlags[k] = match ? match[1] !== 'false' : true;
        }
      } catch { /* ignore, all default to true */ }
    }
  }
  return _autoIndexFlags[key] !== false;
}

// Kill a child process tree, hard. On Windows, child.kill('SIGTERM') only
// signals the immediate child — node subprocesses spawned by it (the fastembed
// model loader, for instance) survive. taskkill /T walks the tree. On POSIX,
// killing the negative PID hits the whole process group we created with
// detached:true. See #744 — execFileSync's own `timeout` does NOT do this and
// orphaned a 2 GB build-embeddings process for 30+ minutes in the wild.
function killProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (platform() === 'win32') {
    try {
      // /F = force, /T = include child processes
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

function runStep(label, cmd, args, timeoutMs = 120_000, extraEnv = null) {
  return new Promise((resolveStep) => {
    const start = Date.now();
    log(`START ${label}`);
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: true,
      detached: platform() !== 'win32', // POSIX: own process group for tree-kill
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (timedOut) {
        log(`FAIL  ${label} (${elapsed}s): timed out after ${timeoutMs}ms, child killed`);
        resolveStep(false);
      } else if (code === 0) {
        log(`DONE  ${label} (${elapsed}s)`);
        resolveStep(true);
      } else {
        log(`FAIL  ${label} (${elapsed}s): exit code ${code}${signal ? ` (signal ${signal})` : ''}`);
        resolveStep(false);
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`FAIL  ${label} (${elapsed}s): ${err.message?.split('\n')[0] || 'unknown'}`);
      resolveStep(false);
    });
  });
}

/**
 * Build the ordered step plan. Each entry is `{ name, cmd, args, timeoutMs, env? }`.
 * Steps disabled in moflo.yaml or whose script can't be located are filtered
 * out here so the run loop only sees runnable steps.
 */
function buildStepPlan() {
  const plan = [];
  const localCli = getLocalCliPath();

  const consider = (name, cfgKey, scriptName, binName, args, timeoutMs = 120_000, env = null) => {
    if (cfgKey && !isIndexEnabled(cfgKey)) {
      log(`SKIP  ${name} (disabled in moflo.yaml)`);
      return;
    }
    const script = scriptName ? resolveBin(binName, scriptName) : null;
    if (scriptName && !script) {
      log(`SKIP  ${name} (script not found)`);
      return;
    }
    plan.push({
      name,
      cmd: 'node',
      args: scriptName ? [script, ...args] : args,
      timeoutMs,
      env,
    });
  };

  consider('guidance-index', 'guidance', 'index-guidance.mjs', 'flo-index',   ['--no-embeddings']);
  consider('code-map',       'code_map', 'generate-code-map.mjs', 'flo-codemap', ['--no-embeddings'], 180_000);
  consider('test-index',     'tests',    'index-tests.mjs',    'flo-testmap', ['--no-embeddings']);
  consider('patterns-index', 'patterns', 'index-patterns.mjs', 'flo-patterns', []);

  // Pretrain extracts patterns from the repo via the CLI subcommand. No
  // direct script — invoke through the local flo binary.
  if (localCli) {
    plan.push({
      name: 'pretrain',
      cmd: 'node',
      args: [localCli, 'hooks', 'pretrain'],
      timeoutMs: 120_000,
    });
  } else {
    log('SKIP  pretrain (CLI not found)');
  }

  // build-embeddings runs fastembed → thread-capped to keep CPU usable.
  consider('build-embeddings', null, 'build-embeddings.mjs', 'flo-embeddings', [], 300_000, ONNX_THREAD_CAP);

  // HNSW MUST run last (after all DB writes are committed, #81). Same thread
  // cap — rebuild-index loads fastembed for stats lookups.
  //
  // No `--force`: the embeddings-migration service (run by the launcher
  // before this chain) handles model bumps, and `build-embeddings` above
  // fills any rows that lack embeddings. So `rebuild-index` finds nothing
  // to embed in steady state and takes the no-work path, which still
  // refreshes the HNSW sidecar via `writeSidecarOrFail` and is followed by
  // the existsSync post-check below. `--force` only added a 4000-row
  // re-embed that the fingerprint gate (#858) is specifically trying to
  // avoid (#859).
  if (localCli) {
    plan.push({
      name: 'hnsw-rebuild',
      cmd: 'node',
      args: [localCli, 'memory', 'rebuild-index'],
      timeoutMs: 300_000,
      env: ONNX_THREAD_CAP,
    });
  } else {
    log('SKIP  hnsw-rebuild (CLI not found)');
  }

  return plan;
}

async function main() {
  const startTime = Date.now();
  const plan = buildStepPlan();

  let ranAny = false;
  let hnswAttempted = false;
  let hnswOk = true;

  for (const step of plan) {
    const gate = decideStepGate(step.name, projectRoot);
    if (gate.skip) {
      log(`SKIP  ${step.name} (${gate.reason})`);
      continue;
    }
    log(`RUN   ${step.name} (${gate.reason})`);
    if (step.name === 'hnsw-rebuild') hnswAttempted = true;
    const ok = await runStep(step.name, step.cmd, step.args, step.timeoutMs, step.env || null);
    if (ok) {
      // POST-run fingerprint: re-compute to capture any state mutated by
      // this step (e.g. build-embeddings bumping memory.db mtime). Saving
      // the POST value lets next session correctly compare against the
      // stable post-step state.
      try {
        const post = computeStepFingerprint(step.name, projectRoot);
        if (!saveStepFingerprint(step.name, projectRoot, post)) {
          log(`WARN  ${step.name} fingerprint save failed (next session will re-run)`);
        }
      } catch (err) {
        const msg = (err && err.message ? err.message.split('\n')[0] : 'unknown');
        log(`WARN  ${step.name} fingerprint compute failed: ${msg}`);
      }
      ranAny = true;
    } else if (step.name === 'hnsw-rebuild') {
      hnswOk = false;
    }
  }

  // hnsw-rebuild post-check: sidecar must physically exist after the step
  // ran successfully. Missing sidecar means cold-start memory search will
  // silently rebuild from SQL on every consumer process — the regression
  // this guard exists to surface (#854). Only meaningful when we actually
  // tried to rebuild.
  if (hnswAttempted && hnswOk) {
    const sidecar = hnswIndexPath(projectRoot);
    if (!existsSync(sidecar)) {
      log(`FAIL  hnsw-rebuild post-check: sidecar missing at ${sidecar}`);
      hnswOk = false;
    }
  }

  // Always tidy up the v1 fingerprint file from 4.9.7 — even on all-skip
  // sessions, otherwise the orphan survives indefinitely.
  cleanupLegacyFingerprint(projectRoot);

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(ranAny
    ? `Sequential indexing chain complete (${totalElapsed}s)`
    : `Sequential indexing chain skipped — all steps gated unchanged (${totalElapsed}s)`);

  if (!hnswOk) process.exit(1);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
