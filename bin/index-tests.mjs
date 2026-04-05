#!/usr/bin/env node
/**
 * Index test files into claude-flow memory under the `tests` namespace
 *
 * Extracts from each test file:
 * - File path
 * - Describe/it/test block names (regex-based, no AST)
 * - Import targets (what modules the test imports — key for reverse mapping)
 * - Test framework detected (vitest, jest, mocha, etc.)
 *
 * Chunk types:
 *   test-file:{path}       — Per-file entry with describe blocks, imports, test names
 *   test-map:{source-file}  — Reverse mapping: source file → test files that import it
 *   test-dir:{path}         — Directory summary of test coverage
 *
 * Usage:
 *   node node_modules/moflo/bin/index-tests.mjs                # Incremental
 *   node node_modules/moflo/bin/index-tests.mjs --force        # Full reindex
 *   node node_modules/moflo/bin/index-tests.mjs --verbose      # Detailed logging
 *   node node_modules/moflo/bin/index-tests.mjs --no-embeddings  # Skip embeddings
 *   node node_modules/moflo/bin/index-tests.mjs --stats        # Print stats and exit
 *   flo-testmap                                            # Via PATH
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative, basename, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, spawn } from 'child_process';
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
const NAMESPACE = 'tests';
const DB_PATH = resolve(projectRoot, '.swarm/memory.db');
const HASH_CACHE_PATH = resolve(projectRoot, '.swarm/tests-hash.txt');

// Parse args
const args = process.argv.slice(2);
const force = args.includes('--force');
const verbose = args.includes('--verbose') || args.includes('-v');
const skipEmbeddings = args.includes('--no-embeddings');
const statsOnly = args.includes('--stats');

function log(msg) { console.log(`[index-tests] ${msg}`); }
function debug(msg) { if (verbose) console.log(`[index-tests]   ${msg}`); }

// ---------------------------------------------------------------------------
// Test file patterns
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /\.test-\w+\.\w+$/,
];

const TEST_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', 'coverage',
  '.claude', '.swarm', '.claude-flow', '.git',
]);

// ---------------------------------------------------------------------------
// Database helpers (same pattern as index-guidance.mjs / generate-code-map.mjs)
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

function storeEntry(db, key, content, metadata = {}, tags = []) {
  const now = Date.now();
  const id = generateId();
  db.run(`
    INSERT OR REPLACE INTO memory_entries
    (id, key, namespace, content, metadata, tags, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `, [id, key, NAMESPACE, content, JSON.stringify(metadata), JSON.stringify(tags), now, now]);
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

function countMissingEmbeddings(db) {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = ? AND (embedding IS NULL OR embedding = '')`);
  stmt.bind([NAMESPACE]);
  let count = 0;
  if (stmt.step()) count = stmt.getAsObject().cnt;
  stmt.free();
  return count;
}

// ---------------------------------------------------------------------------
// Test directory discovery
// ---------------------------------------------------------------------------

/**
 * Load test directories from moflo.yaml or discover automatically.
 */
function loadTestDirs() {
  const yamlPath = resolve(projectRoot, 'moflo.yaml');
  const jsonPath = resolve(projectRoot, 'moflo.config.json');

  // Try moflo.yaml first
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const testsBlock = content.match(/tests:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (testsBlock) {
        const items = testsBlock[1].match(/-\s+(.+)/g);
        if (items && items.length > 0) {
          return items.map(item => item.replace(/^-\s+/, '').trim());
        }
      }
    } catch { /* ignore */ }
  }

  // Try moflo.config.json
  if (existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      if (raw.tests?.directories && Array.isArray(raw.tests.directories)) {
        return raw.tests.directories;
      }
    } catch { /* ignore */ }
  }

  // Auto-discover common test directories
  return discoverTestDirs();
}

/**
 * Discover test directories by checking common locations.
 */
function discoverTestDirs() {
  const candidates = ['tests', 'test', '__tests__', 'spec', 'e2e'];
  const found = [];

  for (const dir of candidates) {
    if (existsSync(resolve(projectRoot, dir))) {
      found.push(dir);
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Test file enumeration
// ---------------------------------------------------------------------------

/**
 * Find all test files using git ls-files + pattern matching.
 */
function getTestFiles() {
  // Strategy 1: git ls-files for tracked test files
  let gitFiles = [];
  try {
    const raw = execSync(
      `git ls-files -- "*.test.*" "*.spec.*" "*.test-*"`,
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();

    if (raw) {
      gitFiles = raw.split('\n').filter(f => {
        // Skip excluded dirs
        for (const ex of EXCLUDE_DIRS) {
          if (f.startsWith(ex + '/') || f.startsWith(ex + '\\')) return false;
        }
        // Only include recognized extensions
        const ext = extname(f);
        return TEST_EXTENSIONS.has(ext);
      });
    }
  } catch { /* git not available or not a repo */ }

  // Strategy 2: Walk configured test directories for any files
  const testDirs = loadTestDirs();
  const walkedFiles = new Set(gitFiles);

  for (const dir of testDirs) {
    const fullDir = resolve(projectRoot, dir);
    if (!existsSync(fullDir)) continue;
    walkTestFiles(fullDir, walkedFiles);
  }

  return [...walkedFiles].sort();
}

/**
 * Walk a directory for test files (*.test.*, *.spec.*, or any source file in test dirs).
 */
function walkTestFiles(dir, results) {
  if (!existsSync(dir)) return;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) {
          walkTestFiles(resolve(dir, entry.name), results);
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!TEST_EXTENSIONS.has(ext)) continue;

        // Include if it matches test patterns OR if it's inside a test directory
        const isTestFile = TEST_FILE_PATTERNS.some(p => p.test(entry.name));
        const isInTestDir = true; // already walking a test dir

        if (isTestFile || isInTestDir) {
          const relPath = relative(projectRoot, resolve(dir, entry.name)).replace(/\\/g, '/');
          results.add(relPath);
        }
      }
    }
  } catch { /* skip unreadable dirs */ }
}

function computeFileListHash(files) {
  const sorted = [...files].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

function isUnchanged(currentHash) {
  if (force) return false;
  if (!existsSync(HASH_CACHE_PATH)) return false;
  const cached = readFileSync(HASH_CACHE_PATH, 'utf-8').trim();
  return cached === currentHash;
}

// ---------------------------------------------------------------------------
// Test file analysis (regex-based, no AST)
// ---------------------------------------------------------------------------

/**
 * Detect test framework from import statements.
 */
function detectFramework(content) {
  if (/from\s+['"]vitest['"]/.test(content) || /import.*vitest/.test(content)) return 'vitest';
  if (/from\s+['"]@jest/.test(content) || /from\s+['"]jest['"]/.test(content)) return 'jest';
  if (/require\s*\(\s*['"]mocha['"]/.test(content)) return 'mocha';
  if (/from\s+['"]@playwright/.test(content)) return 'playwright';
  if (/from\s+['"]cypress['"]/.test(content)) return 'cypress';
  if (/from\s+['"]ava['"]/.test(content)) return 'ava';
  if (/describe\s*\(/.test(content) || /it\s*\(/.test(content) || /test\s*\(/.test(content)) return 'generic';
  return 'unknown';
}

/**
 * Extract describe/it/test block names from test file content.
 */
function extractTestBlocks(content) {
  const blocks = [];

  // Match: describe("name", ...) / describe('name', ...) / describe(`name`, ...)
  const describePattern = /(?:describe|suite)\s*\(\s*(['"`])(.+?)\1/g;
  let m;
  while ((m = describePattern.exec(content)) !== null) {
    blocks.push({ type: 'describe', name: m[2] });
  }

  // Match: it("name", ...) / test("name", ...) / specify("name", ...)
  const testPattern = /(?:it|test|specify)\s*\(\s*(['"`])(.+?)\1/g;
  while ((m = testPattern.exec(content)) !== null) {
    blocks.push({ type: 'test', name: m[2] });
  }

  // Match: it.each / test.each (parameterized)
  const eachPattern = /(?:it|test)\.each[^(]*\(\s*[^)]*\)\s*\(\s*(['"`])(.+?)\1/g;
  while ((m = eachPattern.exec(content)) !== null) {
    blocks.push({ type: 'test', name: m[2] + ' (parameterized)' });
  }

  return blocks;
}

/**
 * Extract import targets — the source files that this test imports.
 * This is the KEY mechanism for mapping tests to functionality.
 */
function extractImportTargets(content, filePath) {
  const imports = [];
  const fileDir = dirname(filePath);

  // ES module imports: import { X } from '../path'
  const esImportPattern = /import\s+(?:{[^}]*}|[\w*]+(?:\s*,\s*{[^}]*})?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = esImportPattern.exec(content)) !== null) {
    const target = m[1];
    // Only track relative imports (not packages)
    if (target.startsWith('.') || target.startsWith('/')) {
      imports.push(resolveImportPath(target, fileDir));
    }
  }

  // CJS requires: const X = require('../path')
  const cjsPattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = cjsPattern.exec(content)) !== null) {
    const target = m[1];
    if (target.startsWith('.') || target.startsWith('/')) {
      imports.push(resolveImportPath(target, fileDir));
    }
  }

  // Dynamic imports: await import('../path')
  const dynamicPattern = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicPattern.exec(content)) !== null) {
    const target = m[1];
    if (target.startsWith('.') || target.startsWith('/')) {
      imports.push(resolveImportPath(target, fileDir));
    }
  }

  return [...new Set(imports)];
}

/**
 * Resolve a relative import path to a project-relative path.
 * Strips extensions if present, normalizes to forward slashes.
 */
function resolveImportPath(importPath, fromDir) {
  // Resolve relative to the importing file's directory
  const resolved = resolve(projectRoot, fromDir, importPath).replace(/\\/g, '/');
  const rel = relative(projectRoot, resolved).replace(/\\/g, '/');

  // Normalize: strip common source extensions (the import may omit them)
  return rel.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
}

// ---------------------------------------------------------------------------
// Chunk generators
// ---------------------------------------------------------------------------

/**
 * Generate per-file test entries.
 */
function generateTestFileEntries(testFiles, analyses) {
  const chunks = [];

  for (const filePath of testFiles) {
    const analysis = analyses[filePath];
    if (!analysis) continue;

    const fileName = basename(filePath);
    const dir = dirname(filePath);

    let content = `# ${fileName} (${filePath})\n`;
    content += `Framework: ${analysis.framework}\n`;
    if (analysis.importTargets.length > 0) {
      content += `Tests: ${analysis.importTargets.map(t => t + '.*').join(', ')}\n`;
    }
    content += '\n';

    // Describe blocks
    const describes = analysis.blocks.filter(b => b.type === 'describe');
    if (describes.length > 0) {
      content += 'Describe blocks:\n';
      for (const d of describes) {
        content += `  - ${d.name}\n`;
      }
      content += '\n';
    }

    // Test names
    const tests = analysis.blocks.filter(b => b.type === 'test');
    if (tests.length > 0) {
      content += `Test cases (${tests.length}):\n`;
      for (const t of tests.slice(0, 30)) { // Cap at 30 to avoid huge entries
        content += `  - ${t.name}\n`;
      }
      if (tests.length > 30) {
        content += `  ... and ${tests.length - 30} more\n`;
      }
      content += '\n';
    }

    // Import targets
    if (analysis.importTargets.length > 0) {
      content += 'Source files under test:\n';
      for (const imp of analysis.importTargets) {
        content += `  - ${imp}\n`;
      }
    }

    const tags = ['test-file', analysis.framework];
    if (filePath.includes('e2e') || filePath.includes('E2E')) tags.push('e2e');
    if (filePath.includes('integration')) tags.push('integration');
    if (filePath.includes('unit')) tags.push('unit');

    chunks.push({
      key: `test-file:${filePath}`,
      content: content.trim(),
      metadata: {
        kind: 'test-file',
        filePath,
        directory: dir,
        framework: analysis.framework,
        describeCount: describes.length,
        testCount: tests.length,
        importTargets: analysis.importTargets,
        describeNames: describes.map(d => d.name),
      },
      tags,
    });
  }

  return chunks;
}

/**
 * Generate reverse mapping: source file → test files that import it.
 * This is the primary value — enables "find tests for this file" queries.
 */
function generateTestMaps(testFiles, analyses) {
  const chunks = [];

  // Build reverse map: source file → [test files]
  const reverseMap = {};
  for (const filePath of testFiles) {
    const analysis = analyses[filePath];
    if (!analysis) continue;

    for (const target of analysis.importTargets) {
      if (!reverseMap[target]) reverseMap[target] = [];
      reverseMap[target].push({
        testFile: filePath,
        framework: analysis.framework,
        testCount: analysis.blocks.filter(b => b.type === 'test').length,
      });
    }
  }

  // Generate a chunk for each source file that has tests
  for (const [sourceFile, testEntries] of Object.entries(reverseMap)) {
    let content = `# Tests for: ${sourceFile}\n\n`;
    content += `${testEntries.length} test file(s) cover this module:\n\n`;

    for (const entry of testEntries) {
      content += `  ${entry.testFile} [${entry.framework}, ${entry.testCount} tests]\n`;
    }

    chunks.push({
      key: `test-map:${sourceFile}`,
      content: content.trim(),
      metadata: {
        kind: 'test-map',
        sourceFile,
        testFiles: testEntries.map(e => e.testFile),
        totalTests: testEntries.reduce((sum, e) => sum + e.testCount, 0),
      },
      tags: ['test-map'],
    });
  }

  return chunks;
}

/**
 * Generate directory summaries showing test coverage per directory.
 */
function generateTestDirSummaries(testFiles, analyses) {
  const chunks = [];

  // Group by directory
  const dirMap = {};
  for (const filePath of testFiles) {
    const dir = dirname(filePath);
    if (!dirMap[dir]) dirMap[dir] = [];
    dirMap[dir].push(filePath);
  }

  for (const [dir, files] of Object.entries(dirMap)) {
    if (files.length < 1) continue;

    const frameworks = new Set();
    let totalTests = 0;
    let totalDescribes = 0;
    const allImports = new Set();

    for (const f of files) {
      const analysis = analyses[f];
      if (!analysis) continue;
      frameworks.add(analysis.framework);
      totalTests += analysis.blocks.filter(b => b.type === 'test').length;
      totalDescribes += analysis.blocks.filter(b => b.type === 'describe').length;
      for (const imp of analysis.importTargets) allImports.add(imp);
    }

    let content = `# ${dir}/ (${files.length} test files)\n`;
    content += `Frameworks: ${[...frameworks].join(', ')}\n`;
    content += `Total: ${totalDescribes} suites, ${totalTests} tests\n\n`;
    content += 'Files:\n';
    for (const f of files) {
      content += `  ${basename(f)}\n`;
    }
    if (allImports.size > 0) {
      content += '\nModules under test:\n';
      for (const imp of [...allImports].sort().slice(0, 20)) {
        content += `  ${imp}\n`;
      }
      if (allImports.size > 20) {
        content += `  ... and ${allImports.size - 20} more\n`;
      }
    }

    chunks.push({
      key: `test-dir:${dir}`,
      content: content.trim(),
      metadata: {
        kind: 'test-dir',
        directory: dir,
        fileCount: files.length,
        frameworks: [...frameworks],
        totalTests,
        totalDescribes,
      },
      tags: ['test-dir'],
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  log(`Project root: ${projectRoot}`);

  // 1. Find test files
  log('Discovering test files...');
  const testFiles = getTestFiles();
  log(`Found ${testFiles.length} test files`);

  if (testFiles.length === 0) {
    log('No test files found — nothing to index');
    return;
  }

  // 2. Check hash for incremental skip
  const currentHash = computeFileListHash(testFiles);

  if (statsOnly) {
    const db = await getDb();
    const count = countNamespace(db);
    db.close();
    log(`Stats: ${testFiles.length} test files, ${count} chunks in tests namespace`);
    log(`File list hash: ${currentHash.slice(0, 12)}...`);
    return;
  }

  if (isUnchanged(currentHash)) {
    const db = await getDb();
    const count = countNamespace(db);
    const missing = countMissingEmbeddings(db);
    db.close();
    if (count > 0) {
      if (missing > 0 && !skipEmbeddings) {
        log(`File list unchanged but ${missing}/${count} entries missing embeddings — generating...`);
        await runEmbeddings();
      } else {
        log(`Skipping — file list unchanged (${count} chunks in DB, hash ${currentHash.slice(0, 12)}...)`);
      }
      return;
    }
    log('File list unchanged but no chunks in DB — forcing regeneration');
  }

  // 3. Analyze all test files
  log('Analyzing test files...');
  const analyses = {};

  for (const filePath of testFiles) {
    const fullPath = resolve(projectRoot, filePath);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      analyses[filePath] = {
        framework: detectFramework(content),
        blocks: extractTestBlocks(content),
        importTargets: extractImportTargets(content, filePath),
      };
      debug(`  ${filePath}: ${analyses[filePath].framework}, ${analyses[filePath].blocks.length} blocks, ${analyses[filePath].importTargets.length} imports`);
    } catch (err) {
      debug(`  ${filePath}: ERROR - ${err.message}`);
    }
  }

  const analyzedCount = Object.keys(analyses).length;
  log(`Analyzed ${analyzedCount} test files`);

  // 4. Generate all chunk types
  log('Generating chunks...');
  const fileChunks = generateTestFileEntries(testFiles, analyses);
  const mapChunks = generateTestMaps(testFiles, analyses);
  const dirChunks = generateTestDirSummaries(testFiles, analyses);

  const allChunks = [...fileChunks, ...mapChunks, ...dirChunks];

  log(`Generated ${allChunks.length} chunks:`);
  log(`  Test file entries:   ${fileChunks.length}`);
  log(`  Reverse maps:        ${mapChunks.length} (source → test files)`);
  log(`  Directory summaries: ${dirChunks.length}`);

  // 5. Write to database
  log('Writing to memory database...');
  const db = await getDb();
  deleteNamespace(db);

  for (const chunk of allChunks) {
    storeEntry(db, chunk.key, chunk.content, chunk.metadata, chunk.tags);
  }

  saveDb(db);
  db.close();

  // 6. Save hash for incremental caching
  writeFileSync(HASH_CACHE_PATH, currentHash, 'utf-8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done in ${elapsed}s — ${allChunks.length} chunks written to tests namespace`);

  // 7. Generate embeddings (inline, like code-map)
  if (!skipEmbeddings && allChunks.length > 0) {
    await runEmbeddings();
  }
}

async function runEmbeddings() {
  const embedCandidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), 'build-embeddings.mjs'),
    resolve(projectRoot, '.claude/scripts/build-embeddings.mjs'),
  ];
  const embedScript = embedCandidates.find(p => existsSync(p));
  if (!embedScript) return;

  log('Generating embeddings for tests...');
  try {
    execSync(`node "${embedScript}" --namespace tests`, {
      cwd: projectRoot,
      stdio: 'inherit',
      timeout: 120000,
      windowsHide: true,
    });
  } catch (err) {
    log(`Warning: embedding generation failed: ${err.message?.split('\n')[0]}`);
  }
}

main().catch(err => {
  console.error('[index-tests] Fatal error:', err);
  process.exit(1);
});
