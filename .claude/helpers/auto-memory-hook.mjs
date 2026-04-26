#!/usr/bin/env node
/**
 * Auto Memory Bridge Hook (ADR-048/049) — Minimal Fallback
 * Full version is copied from package source when available.
 *
 * Usage:
 *   node auto-memory-hook.mjs import   # SessionStart
 *   node auto-memory-hook.mjs sync     # SessionEnd / Stop
 *   node auto-memory-hook.mjs status   # Show bridge status
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const STORE_PATH = join(DATA_DIR, 'auto-memory-store.json');

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const dim = (msg) => console.log(`  ${DIM}${msg}${RESET}`);

// Ensure data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

async function loadMemoryPackage() {
  // Memory was inlined into moflo's cli package by the workspace-collapse epic
  // (#586 / story #598) — the bare `@moflo/memory` specifier no longer resolves.
  // After the final cli collapse (#602) the compiled module ships at
  // <moflo-pkg-root>/dist/src/cli/memory/index.js.
  const MEMORY_REL = join('dist', 'src', 'cli', 'memory', 'index.js');
  const { pathToFileURL } = await import('url');

  // Strategy 1: Resolve moflo's package.json directly from the consumer
  // project — its dirname IS the package root, no walk needed.
  try {
    const { createRequire } = await import('module');
    const require = createRequire(join(PROJECT_ROOT, 'package.json'));
    const pkgRoot = dirname(require.resolve('moflo/package.json'));
    const candidate = join(pkgRoot, MEMORY_REL);
    if (existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  } catch { /* fall through */ }

  // Strategy 2: Walk up from PROJECT_ROOT looking for moflo in any node_modules.
  let searchDir = PROJECT_ROOT;
  const { parse } = await import('path');
  while (searchDir !== parse(searchDir).root) {
    const candidate = join(searchDir, 'node_modules', 'moflo', MEMORY_REL);
    if (existsSync(candidate)) {
      try { return await import(pathToFileURL(candidate).href); } catch { /* fall through */ }
    }
    searchDir = dirname(searchDir);
  }

  return null;
}

async function doImport() {
  const memPkg = await loadMemoryPackage();

  if (!memPkg || !memPkg.AutoMemoryBridge) {
    dim('Memory package not available — auto memory import skipped (non-critical)');
    return;
  }

  // Full implementation deferred to copied version
  dim('Auto memory import available — run init --upgrade for full support');
}

async function doSync() {
  if (!existsSync(STORE_PATH)) {
    dim('No entries to sync');
    return;
  }

  const memPkg = await loadMemoryPackage();

  if (!memPkg || !memPkg.AutoMemoryBridge) {
    dim('Memory package not available — sync skipped (non-critical)');
    return;
  }

  dim('Auto memory sync available — run init --upgrade for full support');
}

function doStatus() {
  console.log('\n=== Auto Memory Bridge Status ===\n');
  console.log('  Package:        Fallback mode (run init --upgrade for full)');
  console.log(`  Store:          ${existsSync(STORE_PATH) ? 'Initialized' : 'Not initialized'}`);
  console.log('');
}

const command = process.argv[2] || 'status';

try {
  switch (command) {
    case 'import': await doImport(); break;
    case 'sync': await doSync(); break;
    case 'status': doStatus(); break;
    default:
      console.log('Usage: auto-memory-hook.mjs <import|sync|status>');
      process.exit(1);
  }
} catch (err) {
  // Hooks must never crash Claude Code - fail silently
  dim(`Error (non-critical): ${err.message}`);
}
