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
import { execFileSync } from 'child_process';

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
    resolve(projectRoot, 'node_modules/moflo/src/@claude-flow/cli/bin/cli.js'),
    resolve(projectRoot, 'node_modules/moflo/bin/cli.js'),
    resolve(projectRoot, 'node_modules/.bin/flo'),
    // Development: local CLI
    resolve(projectRoot, 'src/@claude-flow/cli/bin/cli.js'),
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
  if (isIndexEnabled('guidance')) {
    const guidanceScript = resolveBin('flo-index', 'index-guidance.mjs');
    if (guidanceScript) {
      runStep('guidance-index', 'node', [guidanceScript, '--no-embeddings']);
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
      runStep('code-map', 'node', [codeMapScript, '--no-embeddings'], 180_000);
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
      runStep('test-index', 'node', [testScript, '--no-embeddings']);
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
      runStep('patterns-index', 'node', [patternsScript]);
    } else {
      log('SKIP  patterns-index (script not found)');
    }
  } else {
    log('SKIP  patterns-index (disabled in moflo.yaml)');
  }

  // 5. Pretrain (extracts patterns from repository)
  const localCli = getLocalCliPath();
  if (localCli) {
    runStep('pretrain', 'node', [localCli, 'hooks', 'pretrain']);
  } else {
    log('SKIP  pretrain (CLI not found)');
  }

  // 6. Build embeddings — single pass for ALL namespaces, after all indexers finish.
  //    Individual indexers are called with --no-embeddings to prevent background
  //    embedding spawns that race with this chain (sql.js last-write-wins).
  const embeddingsScript = resolveBin('flo-embeddings', 'build-embeddings.mjs');
  if (embeddingsScript) {
    runStep('build-embeddings', 'node', [embeddingsScript], 300_000);
  } else {
    log('SKIP  build-embeddings (script not found)');
  }

  // 7. HNSW rebuild — MUST run last, after all writes are committed (#81)
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
  process.exit(1);
});
