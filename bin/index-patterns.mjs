#!/usr/bin/env node
/**
 * Index code patterns into claude-flow memory under the `patterns` namespace
 *
 * Extracts per-file patterns (not just aggregate summaries like pretrain):
 *   - Service/controller/repository class patterns
 *   - API route definitions and middleware usage
 *   - Error handling strategies per file
 *   - Export conventions per module
 *   - Test patterns (describe/it structure)
 *   - Configuration patterns
 *
 * Chunk types:
 *   pattern:file:{path}     — Per-file pattern summary
 *   pattern:service:{name}  — Service class patterns
 *   pattern:route:{path}    — API route patterns
 *   pattern:error:{path}    — Error handling patterns per file
 *
 * Usage:
 *   node node_modules/moflo/bin/index-patterns.mjs             # Incremental
 *   node node_modules/moflo/bin/index-patterns.mjs --force     # Full reindex
 *   node node_modules/moflo/bin/index-patterns.mjs --verbose   # Detailed logging
 *   node node_modules/moflo/bin/index-patterns.mjs --stats     # Print stats and exit
 *   npx flo-patterns                                           # Via npx
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { mofloResolveURL } from './lib/moflo-resolve.mjs';
const initSqlJs = (await import(mofloResolveURL('sql.js'))).default;

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const NAMESPACE = 'patterns';
const DB_PATH = resolve(projectRoot, '.swarm/memory.db');
const HASH_CACHE_PATH = resolve(projectRoot, '.swarm/patterns-hash.txt');

const args = process.argv.slice(2);
const force = args.includes('--force');
const verbose = args.includes('--verbose') || args.includes('-v');
const statsOnly = args.includes('--stats');

function log(msg) { console.log(`[index-patterns] ${msg}`); }
function debug(msg) { if (verbose) console.log(`[index-patterns]   ${msg}`); }

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs']);
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', 'coverage',
  '.claude', '.swarm', '.claude-flow', '.git', 'template',
]);

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function ensureDbDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function getDb() {
  ensureDbDir();
  const SQL = await initSqlJs();
  let db;
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'semantic',
      embedding TEXT,
      embedding_model TEXT DEFAULT 'local',
      embedding_dimensions INTEGER,
      tags TEXT,
      metadata TEXT,
      owner_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      UNIQUE(namespace, key)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_key_ns ON memory_entries(key, namespace)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace)`);
  return db;
}

function saveDb(db) {
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

function generateId() {
  return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function storeEntry(db, key, content, tags = []) {
  const now = Date.now();
  const id = generateId();
  db.run(`
    INSERT OR REPLACE INTO memory_entries
    (id, key, namespace, content, metadata, tags, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `, [id, key, NAMESPACE, content, '{}', JSON.stringify(tags), now, now]);
}

function deleteNamespace(db) {
  db.run(`DELETE FROM memory_entries WHERE namespace = ?`, [NAMESPACE]);
}

function countNamespace(db) {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = ?`);
  stmt.bind([NAMESPACE]);
  let count = 0;
  if (stmt.step()) count = stmt.getAsObject().cnt;
  stmt.free();
  return count;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectSourceFiles(dir, maxDepth = 8, depth = 0) {
  if (depth > maxDepth) return [];
  const files = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath, maxDepth, depth + 1));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Pattern extraction — per-file
// ---------------------------------------------------------------------------

function extractFilePatterns(filePath, content) {
  const lines = content.split('\n');
  const relPath = relative(projectRoot, filePath);
  const patterns = [];
  const tags = [];

  // Collect metrics
  const imports = [];
  const exports = [];
  const classes = [];
  const functions = [];
  const routes = [];
  const errorHandling = [];
  const interfaces = [];

  for (const line of lines) {
    const t = line.trim();

    // Imports
    const impMatch = t.match(/^import\s+.*?from\s+['"]([^'"]+)['"]/);
    if (impMatch) imports.push(impMatch[1]);

    // Exports
    if (/^export\s+default\b/.test(t)) exports.push('default');
    const namedExp = t.match(/^export\s+(?:const|function|class|interface|type|enum)\s+(\w+)/);
    if (namedExp) exports.push(namedExp[1]);

    // Classes
    const classMatch = t.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      classes.push(classMatch[1]);
      if (/Service\b/.test(classMatch[1])) tags.push('service');
      if (/Controller\b/.test(classMatch[1])) tags.push('controller');
      if (/Repository\b/.test(classMatch[1])) tags.push('repository');
      if (/Provider\b/.test(classMatch[1])) tags.push('provider');
    }

    // Functions
    const fnMatch = t.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) functions.push(fnMatch[1]);
    const arrowMatch = t.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (arrowMatch) functions.push(arrowMatch[1]);

    // Interfaces/types
    const ifaceMatch = t.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/);
    if (ifaceMatch) interfaces.push(ifaceMatch[1]);

    // Routes
    const routeMatch = t.match(/\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]*)['"]/i);
    if (routeMatch) routes.push(`${routeMatch[1].toUpperCase()} ${routeMatch[2]}`);
    if (/@(Get|Post|Put|Delete|Patch)\s*\(/.test(t)) {
      const dec = t.match(/@(\w+)\s*\(\s*['"]([^'"]*)['"]/);
      if (dec) routes.push(`${dec[1].toUpperCase()} ${dec[2]}`);
    }

    // Error handling
    if (/\bcatch\s*\(/.test(t)) errorHandling.push('try-catch');
    if (/\.catch\(/.test(t)) errorHandling.push('promise-catch');
    if (/throw\s+new\s+(\w+)/.test(t)) {
      const err = t.match(/throw\s+new\s+(\w+)/);
      if (err) errorHandling.push(`throws:${err[1]}`);
    }
  }

  // Only create entries for files with meaningful patterns
  if (classes.length === 0 && functions.length < 2 && routes.length === 0 && interfaces.length < 2) {
    return [];
  }

  // Build human-readable pattern summary for this file
  const parts = [];
  if (classes.length > 0) parts.push(`Classes: ${classes.join(', ')}`);
  if (functions.length > 0) parts.push(`Functions: ${functions.slice(0, 10).join(', ')}${functions.length > 10 ? ` (+${functions.length - 10} more)` : ''}`);
  if (interfaces.length > 0) parts.push(`Types: ${interfaces.slice(0, 8).join(', ')}${interfaces.length > 8 ? ` (+${interfaces.length - 8} more)` : ''}`);
  if (routes.length > 0) parts.push(`Routes: ${routes.join(', ')}`);
  if (exports.length > 0) parts.push(`Exports: ${exports.slice(0, 8).join(', ')}${exports.length > 8 ? ` (+${exports.length - 8} more)` : ''}`);
  if (errorHandling.length > 0) {
    const unique = [...new Set(errorHandling)];
    parts.push(`Error handling: ${unique.join(', ')}`);
  }

  const summary = `# ${relPath}\n${parts.join('\n')}`;

  // File-level pattern entry
  patterns.push({
    key: `pattern:file:${relPath}`,
    content: summary,
    tags: ['file-pattern', ...tags],
  });

  // Service/controller entries get their own chunk for better search
  for (const cls of classes) {
    if (/Service|Controller|Repository|Provider|Handler|Manager/.test(cls)) {
      const clsMethods = functions.filter(f => f !== cls); // rough heuristic
      patterns.push({
        key: `pattern:class:${cls}`,
        content: `# ${cls} (${relPath})\nType: ${tags.filter(t => ['service', 'controller', 'repository', 'provider'].includes(t)).join(', ') || 'class'}\nMethods: ${clsMethods.slice(0, 15).join(', ') || 'none detected'}`,
        tags: ['class-pattern', ...tags],
      });
    }
  }

  // Route entries
  if (routes.length > 0) {
    patterns.push({
      key: `pattern:routes:${relPath}`,
      content: `# Routes in ${relPath}\n${routes.join('\n')}`,
      tags: ['route-pattern', 'api'],
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  // Stats mode
  if (statsOnly) {
    const db = await getDb();
    const count = countNamespace(db);
    const files = collectSourceFiles(projectRoot);
    log(`${files.length} source files, ${count} chunks in patterns namespace`);
    db.close();
    return;
  }

  // Collect files
  const files = collectSourceFiles(projectRoot);
  log(`Found ${files.length} source files`);

  if (files.length === 0) {
    log('No source files found');
    return;
  }

  // Hash check for incremental
  const hashInput = files.map(f => {
    try { return `${f}:${statSync(f).mtimeMs}`; } catch { return f; }
  }).join('\n');
  const currentHash = createHash('sha256').update(hashInput).digest('hex');

  if (!force && existsSync(HASH_CACHE_PATH)) {
    const cached = readFileSync(HASH_CACHE_PATH, 'utf-8').trim();
    if (cached === currentHash) {
      log('No changes detected (use --force to reindex)');
      return;
    }
  }

  // Extract patterns from all files
  const allPatterns = [];
  let filesWithPatterns = 0;

  for (const filePath of files) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }
    const patterns = extractFilePatterns(filePath, content);
    if (patterns.length > 0) {
      filesWithPatterns++;
      allPatterns.push(...patterns);
    }
    debug(`${relative(projectRoot, filePath)}: ${patterns.length} patterns`);
  }

  log(`Extracted ${allPatterns.length} pattern chunks from ${filesWithPatterns} files`);

  // Write to database
  const db = await getDb();
  deleteNamespace(db);

  for (const p of allPatterns) {
    storeEntry(db, p.key, p.content, p.tags);
  }

  saveDb(db);
  db.close();

  // Save hash
  writeFileSync(HASH_CACHE_PATH, currentHash, 'utf-8');

  // Trigger embedding generation in background
  try {
    const embeddingScript = resolve(projectRoot, 'node_modules/moflo/bin/build-embeddings.mjs');
    if (existsSync(embeddingScript)) {
      const child = spawn('node', [embeddingScript, '--namespace', NAMESPACE], {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      debug('Embedding generation started in background');
    }
  } catch { /* ignore */ }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done in ${elapsed}s — ${allPatterns.length} pattern chunks written`);
}

main().catch(err => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
