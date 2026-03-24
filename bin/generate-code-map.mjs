#!/usr/bin/env node
/**
 * Generate structural code map for a monorepo or project.
 *
 * Produces five chunk types stored in the `code-map` namespace of .swarm/memory.db:
 *   1. project:    — one per top-level project directory (bird's-eye overview)
 *   2. dir:        — one per directory with 2+ exported types (drill-down detail)
 *   3. iface-map:  — batched interface-to-implementation mappings
 *   4. type-index:  — batched type-name-to-file-path lookups
 *   5. file:       — ONE PER FILE with exported types (file-level granularity)
 *
 * The `file:` entries are the key improvement — they enable precise semantic search
 * for individual types, entities, and services instead of diluting results across
 * large batches.
 *
 * Design: regex-based extraction (no AST parser), incremental via SHA-256 hash,
 * stores in sql.js memory DB, triggers embedding generation in background.
 *
 * Usage:
 *   node node_modules/moflo/bin/generate-code-map.mjs             # Incremental
 *   node node_modules/moflo/bin/generate-code-map.mjs --force     # Full regenerate
 *   node node_modules/moflo/bin/generate-code-map.mjs --verbose   # Detailed logging
 *   node node_modules/moflo/bin/generate-code-map.mjs --no-embeddings  # Skip embedding generation
 *   node node_modules/moflo/bin/generate-code-map.mjs --stats     # Print stats and exit
 *   npx flo-codemap                                              # Via npx
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, relative, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, spawn } from 'child_process';
import { mofloResolveURL } from './lib/moflo-resolve.mjs';
const initSqlJs = (await import(mofloResolveURL('sql.js'))).default;


const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect project root: walk up from cwd to find a package.json
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
const NAMESPACE = 'code-map';
const DB_PATH = resolve(projectRoot, '.swarm/memory.db');
const HASH_CACHE_PATH = resolve(projectRoot, '.swarm/code-map-hash.txt');

// Directories to exclude from indexing
const EXCLUDE_DIRS = [
  'node_modules', 'dist', 'build', '.next', 'coverage',
  '.claude', 'template', 'back-office-template',
];

// Heuristic descriptions for well-known directory names
const DIR_DESCRIPTIONS = {
  entities: 'MikroORM entity definitions',
  services: 'business logic services',
  routes: 'Fastify route handlers',
  middleware: 'request middleware (auth, validation, tenancy)',
  schemas: 'Zod validation schemas',
  types: 'TypeScript type definitions',
  utils: 'utility helpers',
  config: 'configuration',
  migrations: 'database migrations',
  scripts: 'CLI scripts',
  components: 'React components',
  pages: 'route page components',
  contexts: 'React context providers',
  hooks: 'React custom hooks',
  layout: 'app shell layout',
  themes: 'MUI theme configuration',
  api: 'API client layer',
  locales: 'i18n translation files',
  tests: 'test suites',
  e2e: 'end-to-end tests',
  providers: 'dependency injection providers',
};

// Batch sizes for chunking
const IFACE_MAP_BATCH = 20;
const TYPE_INDEX_BATCH = 30; // Reduced from 80 for better search relevance

// Parse args
const args = process.argv.slice(2);
const force = args.includes('--force');
const verbose = args.includes('--verbose') || args.includes('-v');
const skipEmbeddings = args.includes('--no-embeddings');
const statsOnly = args.includes('--stats');

function log(msg) { console.log(`[code-map] ${msg}`); }
function debug(msg) { if (verbose) console.log(`[code-map]   ${msg}`); }

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

// ---------------------------------------------------------------------------
// Source file enumeration — git ls-files with filesystem fallback
// ---------------------------------------------------------------------------

/** Read code_map config from moflo.yaml (directories, extensions, exclude). */
function readCodeMapConfig() {
  const defaults = {
    directories: ['src'],
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.jsx'],
    exclude: [...EXCLUDE_DIRS],
  };
  try {
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    if (!existsSync(yamlPath)) return defaults;
    const content = readFileSync(yamlPath, 'utf-8');
    // Simple YAML parsing for code_map block
    const block = content.match(/code_map:\s*\n((?:\s+\w+:.*\n?|\s+- .*\n?)+)/);
    if (!block) return defaults;
    const lines = block[1].split('\n');
    let currentKey = null;
    const result = { ...defaults };
    for (const line of lines) {
      const keyMatch = line.match(/^\s+(\w+):/);
      const itemMatch = line.match(/^\s+- (.+)/);
      if (keyMatch) {
        currentKey = keyMatch[1];
        // Inline array: extensions: [".ts", ".tsx"]
        const inlineArray = line.match(/\[([^\]]+)\]/);
        if (inlineArray && (currentKey === 'extensions' || currentKey === 'exclude' || currentKey === 'directories')) {
          result[currentKey] = inlineArray[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        }
      } else if (itemMatch && currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(itemMatch[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
    return result;
  } catch { return defaults; }
}

/** Walk a directory tree collecting source files (filesystem fallback). */
function walkDir(dir, extensions, excludeSet, maxDepth = 8, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  let entries;
  try {
    entries = readdirSync(resolve(projectRoot, dir), { withFileTypes: true });
  } catch { return []; }
  for (const entry of entries) {
    if (excludeSet.has(entry.name)) continue;
    // Use forward slashes for consistent cross-platform paths
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkDir(rel, extensions, excludeSet, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (extensions.has(ext)) results.push(rel);
    }
  }
  return results;
}

function getSourceFiles() {
  // Try git ls-files first (fast, respects .gitignore)
  try {
    const raw = execSync(
      `git ls-files -- "*.ts" "*.tsx" "*.js" "*.mjs" "*.jsx"`,
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();

    if (raw) {
      const files = raw.split('\n').filter(f => {
        for (const ex of EXCLUDE_DIRS) {
          if (f.startsWith(ex + '/') || f.startsWith(ex + '\\')) return false;
        }
        return true;
      });
      if (files.length > 0) return files;
    }
  } catch {
    // git not available or not a git repo — fall through
  }

  // Fallback: walk configured directories from moflo.yaml
  log('git ls-files returned no files — falling back to filesystem walk');
  const config = readCodeMapConfig();
  const extSet = new Set(config.extensions);
  const excludeSet = new Set(config.exclude);
  const files = [];

  for (const dir of config.directories) {
    if (existsSync(resolve(projectRoot, dir))) {
      files.push(...walkDir(dir, extSet, excludeSet));
    }
  }

  return files;
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
// Type extraction (regex-based, no AST)
// ---------------------------------------------------------------------------

const TS_PATTERNS = [
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w,\s.]+))?/,
  /^export\s+(?:default\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s.]+))?/,
  /^export\s+(?:default\s+)?type\s+(\w+)\s*[=<]/,
  /^export\s+(?:const\s+)?enum\s+(\w+)/,
  /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  /^export\s+(?:default\s+)?const\s+(\w+)\s*[=:]/,
];

const ENTITY_DECORATOR = /@Entity\s*\(/;

function extractTypes(filePath) {
  const fullPath = resolve(projectRoot, filePath);
  if (!existsSync(fullPath)) return [];

  let content;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const types = [];
  const seen = new Set();
  let isEntityNext = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (ENTITY_DECORATOR.test(line)) {
      isEntityNext = true;
      continue;
    }

    for (const pattern of TS_PATTERNS) {
      const m = line.match(pattern);
      if (m && m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        const kind = detectKind(line, m[1]);
        const bases = (m[2] || '').trim();
        const implements_ = (m[3] || '').trim();
        types.push({
          name: m[1],
          kind,
          bases: bases || null,
          implements: implements_ || null,
          isEntity: isEntityNext,
          file: filePath,
        });
        isEntityNext = false;
        break;
      }
    }

    if (isEntityNext && !line.startsWith('@') && !line.startsWith('export') && line.length > 0) {
      isEntityNext = false;
    }
  }

  return types;
}

function detectKind(line, name) {
  if (/\bclass\b/.test(line)) return 'class';
  if (/\binterface\b/.test(line)) return 'interface';
  if (/\btype\b/.test(line)) return 'type';
  if (/\benum\b/.test(line)) return 'enum';
  if (/\bfunction\b/.test(line)) return 'function';
  if (/\bconst\b/.test(line)) return 'const';
  return 'export';
}

// ---------------------------------------------------------------------------
// Project structure analysis
// ---------------------------------------------------------------------------

function getProjectName(filePath) {
  const parts = filePath.split('/');

  if (parts[0] === 'packages' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'back-office' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'customer-portal' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'admin-console' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'webhooks' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'mobile-app') return 'mobile-app';
  if (parts[0] === 'tests') return 'tests';
  if (parts[0] === 'scripts') return 'scripts';
  return parts[0];
}

function getDirectory(filePath) {
  return dirname(filePath).replace(/\\/g, '/');
}

function getDirDescription(dirName) {
  const last = dirName.split('/').pop();
  return DIR_DESCRIPTIONS[last] || null;
}

function detectLanguage(filePath) {
  const ext = extname(filePath);
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  if (ext === '.ts') return 'ts';
  if (ext === '.mjs') return 'esm';
  return 'js';
}

// ---------------------------------------------------------------------------
// Chunk generators
// ---------------------------------------------------------------------------

function generateProjectOverviews(filesByProject, typesByProject) {
  const chunks = [];

  for (const [project, files] of Object.entries(filesByProject)) {
    const types = typesByProject[project] || [];
    const lang = detectProjectLang(files);
    const dirMap = {};

    for (const t of types) {
      const rel = relative(project, dirname(t.file)).replace(/\\/g, '/') || '(root)';
      if (!dirMap[rel]) dirMap[rel] = [];
      dirMap[rel].push(t.name);
    }

    let content = `# ${project} [${lang}, ${files.length} files, ${types.length} types]\n\n`;

    const sortedDirs = Object.keys(dirMap).sort();
    for (const dir of sortedDirs) {
      const names = dirMap[dir];
      const desc = getDirDescription(dir);
      const descStr = desc ? ` -- ${desc}` : '';
      const shown = names.slice(0, 8).join(', ');
      const overflow = names.length > 8 ? `, ... (+${names.length - 8} more)` : '';
      content += `  ${dir}${descStr}: ${shown}${overflow}\n`;
    }

    chunks.push({
      key: `project:${project}`,
      content: content.trim(),
      metadata: { kind: 'project-overview', project, language: lang, fileCount: files.length, typeCount: types.length },
      tags: ['project', project],
    });
  }

  return chunks;
}

function detectProjectLang(files) {
  let tsx = 0, ts = 0, js = 0;
  for (const f of files) {
    const ext = extname(f);
    if (ext === '.tsx' || ext === '.jsx') tsx++;
    else if (ext === '.ts') ts++;
    else js++;
  }
  if (tsx > ts && tsx > js) return 'React/TypeScript';
  if (ts >= js) return 'TypeScript';
  return 'JavaScript';
}

function generateDirectoryDetails(typesByDir) {
  const chunks = [];

  for (const [dir, types] of Object.entries(typesByDir)) {
    if (types.length < 2) continue;

    const desc = getDirDescription(dir);
    let content = `# ${dir} (${types.length} types)\n`;
    if (desc) content += `${desc}\n`;
    content += '\n';

    const sorted = [...types].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of sorted) {
      const suffix = [];
      if (t.bases) suffix.push(`: ${t.bases}`);
      if (t.implements) suffix.push(`: ${t.implements}`);
      const suffixStr = suffix.length ? ` ${suffix.join(' ')}` : '';
      const fileName = basename(t.file);
      content += `  ${t.name}${suffixStr} (${fileName})\n`;
    }

    chunks.push({
      key: `dir:${dir}`,
      content: content.trim(),
      metadata: { kind: 'directory-detail', directory: dir, typeCount: types.length },
      tags: ['directory', dir.split('/')[0]],
    });
  }

  return chunks;
}

function generateInterfaceMaps(allTypes) {
  const interfaces = new Map();

  for (const t of allTypes) {
    if (t.kind === 'interface') {
      if (!interfaces.has(t.name)) {
        interfaces.set(t.name, { defined: t.file, implementations: [] });
      }
    }
  }

  for (const t of allTypes) {
    if (t.kind !== 'class') continue;
    const impls = t.implements ? t.implements.split(',').map(s => s.trim()) : [];
    const bases = t.bases ? [t.bases.trim()] : [];
    for (const iface of [...impls, ...bases]) {
      if (interfaces.has(iface)) {
        interfaces.get(iface).implementations.push({
          name: t.name,
          project: getProjectName(t.file),
        });
      }
    }
  }

  const mapped = [...interfaces.entries()]
    .filter(([, v]) => v.implementations.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (mapped.length === 0) return [];

  const chunks = [];
  const totalBatches = Math.ceil(mapped.length / IFACE_MAP_BATCH);

  for (let i = 0; i < mapped.length; i += IFACE_MAP_BATCH) {
    const batch = mapped.slice(i, i + IFACE_MAP_BATCH);
    const batchNum = Math.floor(i / IFACE_MAP_BATCH) + 1;

    let content = `# Interface-to-Implementation Map (${batchNum}/${totalBatches})\n\n`;
    for (const [name, info] of batch) {
      const implStr = info.implementations
        .map(impl => `${impl.name} (${impl.project})`)
        .join(', ');
      content += `  ${name} -> ${implStr}\n`;
    }

    chunks.push({
      key: `iface-map:${batchNum}`,
      content: content.trim(),
      metadata: { kind: 'interface-map', batch: batchNum, totalBatches, count: batch.length },
      tags: ['interface-map'],
    });
  }

  return chunks;
}

function generateTypeIndex(allTypes) {
  const sorted = [...allTypes].sort((a, b) => a.name.localeCompare(b.name));
  const chunks = [];
  const totalBatches = Math.ceil(sorted.length / TYPE_INDEX_BATCH);

  for (let i = 0; i < sorted.length; i += TYPE_INDEX_BATCH) {
    const batch = sorted.slice(i, i + TYPE_INDEX_BATCH);
    const batchNum = Math.floor(i / TYPE_INDEX_BATCH) + 1;

    let content = `# Type Index (batch ${batchNum}, ${batch.length} types)\n\n`;
    for (const t of batch) {
      const lang = detectLanguage(t.file);
      content += `  ${t.name} -> ${t.file} [${lang}]\n`;
    }

    chunks.push({
      key: `type-index:${batchNum}`,
      content: content.trim(),
      metadata: { kind: 'type-index', batch: batchNum, totalBatches, count: batch.length },
      tags: ['type-index'],
    });
  }

  return chunks;
}

/**
 * NEW: Generate file-level entries for each source file that has exported types.
 *
 * Each file gets its own entry keyed as `file:<path>`, containing:
 * - The file path
 * - All exported type names with their kind, base class, and implementations
 * - Whether it's a MikroORM entity
 * - The project and directory it belongs to
 *
 * This enables precise semantic search: a query for "CompanyAuditLog" will match
 * the specific file entry rather than being diluted across a batch of 80 types.
 */
function generateFileEntries(typesByFile) {
  const chunks = [];

  for (const [filePath, types] of Object.entries(typesByFile)) {
    if (types.length === 0) continue;

    const project = getProjectName(filePath);
    const dir = getDirectory(filePath);
    const dirDesc = getDirDescription(dir);
    const lang = detectLanguage(filePath);
    const fileName = basename(filePath);

    // Build a rich, searchable content string
    let content = `# ${fileName} (${filePath})\n`;
    content += `Project: ${project} | Language: ${lang}\n`;
    if (dirDesc) content += `Directory: ${dirDesc}\n`;
    content += '\nExported types:\n';

    for (const t of types) {
      let line = `  ${t.kind} ${t.name}`;
      if (t.isEntity) line += ' [MikroORM entity]';
      if (t.bases) line += ` extends ${t.bases}`;
      if (t.implements) line += ` implements ${t.implements}`;
      content += line + '\n';
    }

    // Build tags for filtering
    const tags = ['file', project];
    if (types.some(t => t.isEntity)) tags.push('entity');
    if (types.some(t => t.kind === 'interface')) tags.push('interface');
    if (filePath.includes('/services/')) tags.push('service');
    if (filePath.includes('/routes/')) tags.push('route');
    if (filePath.includes('/middleware/')) tags.push('middleware');

    chunks.push({
      key: `file:${filePath}`,
      content: content.trim(),
      metadata: {
        kind: 'file-detail',
        filePath,
        project,
        directory: dir,
        language: lang,
        typeCount: types.length,
        hasEntities: types.some(t => t.isEntity),
        typeNames: types.map(t => t.name),
      },
      tags,
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

  // 1. Get source files
  log('Enumerating source files via git ls-files...');
  const files = getSourceFiles();
  log(`Found ${files.length} source files`);

  if (files.length === 0) {
    log('No source files found — nothing to index');
    return;
  }

  // 2. Check hash for incremental skip
  const currentHash = computeFileListHash(files);

  if (statsOnly) {
    const db = await getDb();
    const count = countNamespace(db);
    db.close();
    log(`Stats: ${files.length} source files, ${count} chunks in code-map namespace`);
    log(`File list hash: ${currentHash.slice(0, 12)}...`);
    return;
  }

  if (isUnchanged(currentHash)) {
    const db = await getDb();
    const count = countNamespace(db);
    db.close();
    if (count > 0) {
      log(`Skipping — file list unchanged (${count} chunks in DB, hash ${currentHash.slice(0, 12)}...)`);
      return;
    }
    log('File list unchanged but no chunks in DB — forcing regeneration');
  }

  // 3. Extract types from all files
  log('Extracting type declarations...');
  const allTypes = [];
  const filesByProject = {};
  const typesByProject = {};
  const typesByDir = {};
  const typesByFile = {};

  for (const file of files) {
    const project = getProjectName(file);
    if (!filesByProject[project]) filesByProject[project] = [];
    filesByProject[project].push(file);

    const types = extractTypes(file);

    // Track types per file for file-level entries
    if (types.length > 0) {
      typesByFile[file] = types;
    }

    for (const t of types) {
      allTypes.push(t);

      if (!typesByProject[project]) typesByProject[project] = [];
      typesByProject[project].push(t);

      const dir = getDirectory(t.file);
      if (!typesByDir[dir]) typesByDir[dir] = [];
      typesByDir[dir].push(t);
    }
  }

  log(`Extracted ${allTypes.length} type declarations from ${Object.keys(filesByProject).length} projects`);
  log(`Files with exported types: ${Object.keys(typesByFile).length}`);

  // 4. Generate all chunk types
  log('Generating chunks...');
  const projectChunks = generateProjectOverviews(filesByProject, typesByProject);
  const dirChunks = generateDirectoryDetails(typesByDir);
  const ifaceChunks = generateInterfaceMaps(allTypes);
  const typeIdxChunks = generateTypeIndex(allTypes);
  const fileChunks = generateFileEntries(typesByFile);

  const allChunks = [...projectChunks, ...dirChunks, ...ifaceChunks, ...typeIdxChunks, ...fileChunks];

  log(`Generated ${allChunks.length} chunks:`);
  log(`  Project overviews: ${projectChunks.length}`);
  log(`  Directory details: ${dirChunks.length}`);
  log(`  Interface maps:    ${ifaceChunks.length}`);
  log(`  Type index:        ${typeIdxChunks.length}`);
  log(`  File entries:      ${fileChunks.length} (NEW — file-level granularity)`);

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
  log(`Done in ${elapsed}s — ${allChunks.length} chunks written to code-map namespace`);

  // 7. Generate embeddings inline (not detached — ensures Xenova runs reliably)
  if (!skipEmbeddings) {
    // Prefer moflo's own bin script, fall back to project's .claude/scripts/
    const embedCandidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), 'build-embeddings.mjs'),
      resolve(projectRoot, '.claude/scripts/build-embeddings.mjs'),
    ];
    const embedScript = embedCandidates.find(p => existsSync(p));
    if (embedScript) {
      log('Generating embeddings for code-map...');
      try {
        execSync(`node "${embedScript}" --namespace code-map`, {
          cwd: projectRoot,
          stdio: 'inherit',
          timeout: 120000,
          windowsHide: true,
        });
      } catch (err) {
        log(`Warning: embedding generation failed: ${err.message?.split('\n')[0]}`);
      }
    }
  }
}

main().catch(err => {
  console.error('[code-map] Fatal error:', err);
  process.exit(1);
});
