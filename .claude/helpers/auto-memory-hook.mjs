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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
  // Strategy 1: Use createRequire for CJS-style resolution (handles nested node_modules
  // when installed as a transitive dependency via npx ruflo / npx claude-flow)
  try {
    const { createRequire } = await import('module');
    const require = createRequire(join(PROJECT_ROOT, 'package.json'));
    return require('@moflo/memory');
  } catch { /* fall through */ }

  // Strategy 2: ESM import (works when @moflo/memory is a direct dependency)
  try { return await import('@moflo/memory'); } catch { /* fall through */ }

  // Strategy 3: Walk up from PROJECT_ROOT looking for the package in any node_modules
  let searchDir = PROJECT_ROOT;
  const { parse } = await import('path');
  while (searchDir !== parse(searchDir).root) {
    const candidate = join(searchDir, 'node_modules', '@claude-flow', 'memory', 'dist', 'index.js');
    if (existsSync(candidate)) {
      try { const { pathToFileURL } = await import('url'); return await import(pathToFileURL(candidate).href); } catch { /* fall through */ }
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
