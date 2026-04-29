#!/usr/bin/env node
/**
 * Sequential indexer chain for session-start.
 *
 * Runs all DB-writing indexers one at a time to avoid sql.js last-write-wins
 * concurrency issues (#78), then triggers HNSW rebuild once everything is
 * committed (#81).
 *
 * Spawned as a single detached background process by hooks.mjs session-start.
 */

import { existsSync, appendFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { platform } from 'os';

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

function runStep(label, cmd, args, timeoutMs = 120_000) {
  return new Promise((resolveStep) => {
    const start = Date.now();
    log(`START ${label}`);
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: true,
      detached: platform() !== 'win32', // POSIX: own process group for tree-kill
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

async function main() {
  const startTime = Date.now();
  log('Sequential indexing chain started');

  // 1. Guidance indexer
  if (isIndexEnabled('guidance')) {
    const guidanceScript = resolveBin('flo-index', 'index-guidance.mjs');
    if (guidanceScript) {
      await runStep('guidance-index', 'node', [guidanceScript, '--no-embeddings']);
    } else {
      log('SKIP  guidance-index (script not found)');
    }
  } else {
    log('SKIP  guidance-index (disabled in moflo.yaml)');
  }

  // 2. Code map generator (the big one — ~22s)
  if (isIndexEnabled('code_map')) {
    const codeMapScript = resolveBin('flo-codemap', 'generate-code-map.mjs');
    if (codeMapScript) {
      await runStep('code-map', 'node', [codeMapScript, '--no-embeddings'], 180_000);
    } else {
      log('SKIP  code-map (script not found)');
    }
  } else {
    log('SKIP  code-map (disabled in moflo.yaml)');
  }

  // 3. Test indexer
  if (isIndexEnabled('tests')) {
    const testScript = resolveBin('flo-testmap', 'index-tests.mjs');
    if (testScript) {
      await runStep('test-index', 'node', [testScript, '--no-embeddings']);
    } else {
      log('SKIP  test-index (script not found)');
    }
  } else {
    log('SKIP  test-index (disabled in moflo.yaml)');
  }

  // 4. Patterns indexer
  if (isIndexEnabled('patterns')) {
    const patternsScript = resolveBin('flo-patterns', 'index-patterns.mjs');
    if (patternsScript) {
      await runStep('patterns-index', 'node', [patternsScript]);
    } else {
      log('SKIP  patterns-index (script not found)');
    }
  } else {
    log('SKIP  patterns-index (disabled in moflo.yaml)');
  }

  // 5. Pretrain (extracts patterns from repository)
  const localCli = getLocalCliPath();
  if (localCli) {
    await runStep('pretrain', 'node', [localCli, 'hooks', 'pretrain']);
  } else {
    log('SKIP  pretrain (CLI not found)');
  }

  // 6. Build embeddings — single pass for ALL namespaces, after all indexers finish.
  //    Individual indexers are called with --no-embeddings to prevent background
  //    embedding spawns that race with this chain (sql.js last-write-wins).
  const embeddingsScript = resolveBin('flo-embeddings', 'build-embeddings.mjs');
  if (embeddingsScript) {
    await runStep('build-embeddings', 'node', [embeddingsScript], 300_000);
  } else {
    log('SKIP  build-embeddings (script not found)');
  }

  // 7. HNSW rebuild — MUST run last, after all writes are committed (#81)
  if (localCli) {
    await runStep('hnsw-rebuild', 'node', [localCli, 'memory', 'rebuild-index', '--force']);
  } else {
    log('SKIP  hnsw-rebuild (CLI not found)');
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Sequential indexing chain complete (${totalElapsed}s)`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
