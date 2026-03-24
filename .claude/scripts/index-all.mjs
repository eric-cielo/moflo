#!/usr/bin/env node
/**
 * Sequential indexer chain for session-start.
 *
 * Runs all DB-writing indexers one at a time to avoid sql.js last-write-wins
 * concurrency issues, then triggers HNSW rebuild once everything is committed.
 *
 * Spawned as a single detached background process by hooks.mjs session-start.
 */

import { existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const LOG_PATH = resolve(projectRoot, '.claude/hooks.log');

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
  return null;
}

function getLocalCliPath() {
  const paths = [
    resolve(projectRoot, 'node_modules/moflo/bin/cli.js'),
    resolve(projectRoot, 'node_modules/.bin/flo'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function runStep(label, cmd, args, timeoutMs = 120_000) {
  const start = Date.now();
  log(`START ${label}`);
  try {
    execFileSync(cmd, args, {
      cwd: projectRoot,
      timeout: timeoutMs,
      stdio: 'ignore',
      windowsHide: true,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`DONE  ${label} (${elapsed}s)`);
    return true;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`FAIL  ${label} (${elapsed}s): ${err.message?.split('\n')[0] || 'unknown'}`);
    return false;
  }
}

async function main() {
  const startTime = Date.now();
  log('Sequential indexing chain started');

  // 1. Guidance indexer
  const guidanceScript = resolveBin('flo-index', 'index-guidance.mjs');
  if (guidanceScript) {
    runStep('guidance-index', 'node', [guidanceScript]);
  } else {
    log('SKIP  guidance-index (script not found)');
  }

  // 2. Code map generator (the big one — ~22s)
  const codeMapScript = resolveBin('flo-codemap', 'generate-code-map.mjs');
  if (codeMapScript) {
    runStep('code-map', 'node', [codeMapScript], 180_000);
  } else {
    log('SKIP  code-map (script not found)');
  }

  // 3. Test indexer
  const testScript = resolveBin('flo-testmap', 'index-tests.mjs');
  if (testScript) {
    runStep('test-index', 'node', [testScript]);
  } else {
    log('SKIP  test-index (script not found)');
  }

  // 4. HNSW rebuild — MUST run last, after all writes are committed
  const localCli = getLocalCliPath();
  if (localCli) {
    runStep('hnsw-rebuild', 'node', [localCli, 'memory', 'rebuild', '--force']);
  } else {
    log('SKIP  hnsw-rebuild (CLI not found)');
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Sequential indexing chain complete (${totalElapsed}s)`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(0);
});
