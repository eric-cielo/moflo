#!/usr/bin/env node
/**
 * Index guidance files into claude-flow memory with full RAG linked segments
 *
 * Strategy:
 * - Full documents stored as `doc-{name}` for complete retrieval
 * - Semantic chunks stored as `chunk-{name}-{n}` for precise search
 * - FULL RAG LINKING:
 *   - parentDoc: link to full document
 *   - prevChunk/nextChunk: forward/backward navigation
 *   - siblings: all chunk keys from same document
 *   - children: sub-chunks for hierarchical headers (h2 -> h3)
 *   - contextBefore/contextAfter: overlapping text for context continuity
 * - Chunking based on markdown headers (## and ###) for natural boundaries
 * - After indexing, generates embeddings for semantic search (HNSW)
 *
 * Usage:
 *   node node_modules/moflo/bin/index-guidance.mjs                 # Index all + generate embeddings
 *   flo-index --force                                        # Force reindex all
 *   flo-index --file X                                       # Index specific file
 *   flo-index --no-embeddings                                # Skip embedding generation
 *   flo-index --overlap 20                                   # Set context overlap % (default: 15)
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, relative, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
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

// Locate the moflo package root (for bundled guidance that ships with moflo)
const mofloRoot = resolve(__dirname, '..');

const NAMESPACE = 'guidance';
const DB_PATH = resolve(projectRoot, '.swarm/memory.db');

// ============================================================================
// Load guidance directories from moflo.yaml, falling back to defaults
// ============================================================================

function loadGuidanceDirs() {
  const dirs = [];

  // 1. Read moflo.yaml / moflo.config.json for user-configured directories
  let configDirs = null;
  const yamlPath = resolve(projectRoot, 'moflo.yaml');
  const jsonPath = resolve(projectRoot, 'moflo.config.json');

  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      // Simple YAML array extraction — avoids needing js-yaml at runtime
      // Matches:  guidance:\n    directories:\n      - .claude/guidance\n      - docs/guides
      const guidanceBlock = content.match(/guidance:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (guidanceBlock) {
        const items = guidanceBlock[1].match(/-\s+(.+)/g);
        if (items && items.length > 0) {
          configDirs = items.map(item => item.replace(/^-\s+/, '').trim());
        }
      }
    } catch { /* ignore parse errors, fall through to defaults */ }
  } else if (existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      if (raw.guidance?.directories && Array.isArray(raw.guidance.directories)) {
        configDirs = raw.guidance.directories;
      }
    } catch { /* ignore parse errors */ }
  }

  // Use config dirs or fall back to defaults
  // Each directory gets a unique prefix derived from its path to avoid key collisions
  // when multiple directories contain files with the same name.
  const userDirs = configDirs || ['.claude/guidance', 'docs/guides'];
  for (const d of userDirs) {
    const prefix = d.replace(/\\/g, '/')
      .replace(/^\.claude\//, '')
      .replace(/^back-office\/api\/\.claude\//, 'bo-api-')
      .replace(/^back-office\/ui\/\.claude\//, 'bo-ui-')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'guidance';
    dirs.push({ path: d, prefix });
  }

  // 2. Include moflo's own bundled guidance (ships with the package)
  //    Only when running inside a consumer project (not moflo itself)
  //    Shipped guidance lives in .claude/guidance/shipped/ — internal/ is excluded from npm
  const bundledShippedDir = resolve(mofloRoot, '.claude/guidance/shipped');
  const bundledGuidanceDir = existsSync(bundledShippedDir)
    ? bundledShippedDir
    : resolve(mofloRoot, '.claude/guidance');
  const projectGuidanceDir = resolve(projectRoot, '.claude/guidance');

  // Detect self-reference: if the project IS the moflo package, skip bundled scan
  // to avoid double-indexing the same files under two prefixes.
  let isSelfRef = false;
  try {
    const projPkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'));
    const mofloPkg = JSON.parse(readFileSync(resolve(mofloRoot, 'package.json'), 'utf-8'));
    isSelfRef = projPkg.name === mofloPkg.name;
  } catch { /* ignore — defaults to false */ }

  if (
    !isSelfRef &&
    existsSync(bundledGuidanceDir) &&
    resolve(bundledGuidanceDir) !== resolve(projectGuidanceDir) &&
    resolve(bundledGuidanceDir) !== resolve(projectGuidanceDir, 'shipped')
  ) {
    dirs.push({ path: bundledGuidanceDir, prefix: 'moflo-bundled', absolute: true });
  }

  // 3. CLAUDE.md files are NOT indexed — Claude loads them into context automatically.
  //    Indexing them wastes vectors and creates duplicate keys across subprojects.

  return dirs;
}

const GUIDANCE_DIRS = loadGuidanceDirs();

// Chunking config - optimized for Claude's retrieval
const MIN_CHUNK_SIZE = 50;    // Lower minimum to avoid mega-chunks
const MAX_CHUNK_SIZE = 4000;  // Larger chunks for code-heavy docs (fits context better)
const FORCE_CHUNK_THRESHOLD = 6000; // Force paragraph-split if file > this and < 3 chunks
const DEFAULT_OVERLAP_PERCENT = 20; // Increased context overlap for better continuity

// Parse args
const args = process.argv.slice(2);
const force = args.includes('--force');
const specificFile = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const verbose = args.includes('--verbose') || args.includes('-v');
const skipEmbeddings = args.includes('--no-embeddings');
const overlapPercent = args.includes('--overlap')
  ? parseInt(args[args.indexOf('--overlap') + 1], 10) || DEFAULT_OVERLAP_PERCENT
  : DEFAULT_OVERLAP_PERCENT;

function log(msg) {
  console.log(`[index-guidance] ${msg}`);
}

function debug(msg) {
  if (verbose) console.log(`[index-guidance]   ${msg}`);
}

function ensureDbDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
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

  // Ensure table exists with unique constraint
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

function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

function storeEntry(db, key, content, metadata = {}, tags = []) {
  const now = Date.now();
  const id = generateId();
  const metaJson = JSON.stringify(metadata);
  const tagsJson = JSON.stringify(tags);

  db.run(`
    INSERT OR REPLACE INTO memory_entries
    (id, key, namespace, content, metadata, tags, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `, [id, key, NAMESPACE, content, metaJson, tagsJson, now, now]);

  return true;
}

function deleteByPrefix(db, prefix) {
  db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key LIKE ?`, [NAMESPACE, `${prefix}%`]);
}

function getEntryHash(db, key) {
  const stmt = db.prepare('SELECT metadata FROM memory_entries WHERE key = ? AND namespace = ?');
  stmt.bind([key, NAMESPACE]);
  const entry = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (entry?.metadata) {
    try {
      const meta = JSON.parse(entry.metadata);
      return meta.contentHash;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Extract overlapping context from adjacent text
 * @param {string} text - The text to extract from
 * @param {number} percent - Percentage of text to extract
 * @param {string} position - 'start' or 'end'
 * @returns {string} - The extracted context
 */
function extractOverlapContext(text, percent, position) {
  if (!text || percent <= 0) return '';

  const targetLength = Math.floor(text.length * (percent / 100));
  if (targetLength < 20) return ''; // Too short to be useful

  if (position === 'start') {
    // Get first N% of text, try to break at sentence/paragraph
    let end = targetLength;
    const nextPara = text.indexOf('\n\n', targetLength - 50);
    const nextSentence = text.indexOf('. ', targetLength - 30);

    if (nextPara > 0 && nextPara < targetLength + 100) {
      end = nextPara;
    } else if (nextSentence > 0 && nextSentence < targetLength + 50) {
      end = nextSentence + 1;
    }

    return text.substring(0, end).trim();
  } else {
    // Get last N% of text, try to break at sentence/paragraph
    let start = text.length - targetLength;
    const prevPara = text.lastIndexOf('\n\n', start + 50);
    const prevSentence = text.lastIndexOf('. ', start + 30);

    if (prevPara > 0 && prevPara > start - 100) {
      start = prevPara + 2;
    } else if (prevSentence > 0 && prevSentence > start - 50) {
      start = prevSentence + 2;
    }

    return text.substring(start).trim();
  }
}

/**
 * Split markdown content into semantic chunks based on headers
 * Returns array of { title, content, level, headerLine }
 */
function chunkMarkdown(content, fileName) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = { title: fileName, content: [], level: 0, headerLine: 0 };

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    // Strip CRLF carriage returns for Windows compatibility
    const line = lines[lineNum].replace(/\r$/, '');

    // Check for headers (## and ###)
    const h2Match = line.match(/^## (.+)$/);
    const h3Match = line.match(/^### (.+)$/);

    if (h2Match || h3Match) {
      // Save current chunk if it has content
      if (currentChunk.content.length > 0) {
        const chunkContent = currentChunk.content.join('\n').trim();
        if (chunkContent.length >= MIN_CHUNK_SIZE) {
          chunks.push({
            title: currentChunk.title,
            content: chunkContent,
            level: currentChunk.level,
            headerLine: currentChunk.headerLine
          });
        }
      }

      // Start new chunk
      currentChunk = {
        title: h2Match ? h2Match[1] : h3Match[1],
        content: [line],
        level: h2Match ? 2 : 3,
        headerLine: lineNum
      };
    } else {
      currentChunk.content.push(line);
    }
  }

  // Don't forget the last chunk
  if (currentChunk.content.length > 0) {
    const chunkContent = currentChunk.content.join('\n').trim();
    if (chunkContent.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        title: currentChunk.title,
        content: chunkContent,
        level: currentChunk.level,
        headerLine: currentChunk.headerLine
      });
    }
  }

  // Handle chunks that are too large - split by paragraphs
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.content.length > MAX_CHUNK_SIZE) {
      const paragraphs = chunk.content.split(/\n\n+/);
      let currentPart = [];
      let currentLength = 0;
      let partNum = 1;

      for (const para of paragraphs) {
        if (currentLength + para.length > MAX_CHUNK_SIZE && currentPart.length > 0) {
          finalChunks.push({
            title: `${chunk.title} (part ${partNum})`,
            content: currentPart.join('\n\n'),
            level: chunk.level,
            headerLine: chunk.headerLine,
            isPart: true,
            partNum
          });
          currentPart = [para];
          currentLength = para.length;
          partNum++;
        } else {
          currentPart.push(para);
          currentLength += para.length;
        }
      }

      if (currentPart.length > 0) {
        finalChunks.push({
          title: partNum > 1 ? `${chunk.title} (part ${partNum})` : chunk.title,
          content: currentPart.join('\n\n'),
          level: chunk.level,
          headerLine: chunk.headerLine,
          isPart: partNum > 1,
          partNum: partNum > 1 ? partNum : undefined
        });
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  // FORCE CHUNKING: If file is large but resulted in few chunks, split by sections
  const totalContent = finalChunks.reduce((acc, c) => acc + c.content.length, 0);
  if (totalContent > FORCE_CHUNK_THRESHOLD && finalChunks.length < 3) {
    debug(`  Force-chunking: ${totalContent} bytes in ${finalChunks.length} chunks - splitting by sections`);
    const allContent = finalChunks.map(c => c.content).join('\n\n');

    // Split on --- horizontal rules first, then on ## headers, then on paragraphs
    const TARGET_CHUNK_SIZE = 2500;
    const rawSections = allContent.split(/\n---+\n/);
    let sections = [];

    for (const raw of rawSections) {
      // Further split on ## headers if section is too large
      if (raw.length > TARGET_CHUNK_SIZE) {
        const headerSplit = raw.split(/\n(?=## )/);
        for (const hSect of headerSplit) {
          if (hSect.length > TARGET_CHUNK_SIZE) {
            // Split very long sections on single newlines as last resort
            const lines = hSect.split('\n');
            let chunk = '';
            for (const line of lines) {
              if (chunk.length + line.length > TARGET_CHUNK_SIZE && chunk.length > 100) {
                sections.push(chunk.trim());
                chunk = line;
              } else {
                chunk += (chunk ? '\n' : '') + line;
              }
            }
            if (chunk.trim().length > 30) sections.push(chunk.trim());
          } else if (hSect.trim().length > 30) {
            sections.push(hSect.trim());
          }
        }
      } else if (raw.trim().length > 30) {
        sections.push(raw.trim());
      }
    }

    // Now group sections into chunks
    const forcedChunks = [];
    let currentGroup = [];
    let currentLength = 0;
    let groupNum = 1;

    const flushGroup = () => {
      if (currentGroup.length === 0) return;
      const firstLine = currentGroup[0].split('\n')[0].trim();
      const title = firstLine.startsWith('#')
        ? firstLine.replace(/^#+\s*/, '').slice(0, 60)
        : `${fileName} Section ${groupNum}`;

      forcedChunks.push({
        title,
        content: currentGroup.join('\n\n'),
        level: 2,
        headerLine: 0,
        isForced: true,
        forceNum: groupNum
      });
      groupNum++;
      currentGroup = [];
      currentLength = 0;
    };

    for (const section of sections) {
      if (currentLength + section.length > TARGET_CHUNK_SIZE && currentGroup.length > 0) {
        flushGroup();
      }
      currentGroup.push(section);
      currentLength += section.length;
    }
    flushGroup();

    // Always use force-chunked results if we got multiple chunks
    if (forcedChunks.length >= 2) {
      debug(`  Force-chunking produced ${forcedChunks.length} chunks (was ${finalChunks.length})`);
      return forcedChunks;
    }
  }

  return finalChunks;
}

/**
 * Build hierarchical relationships between chunks
 * H2 chunks are parents of subsequent H3 chunks
 */
function buildHierarchy(chunks, chunkPrefix) {
  const hierarchy = {};
  let currentH2Index = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkKey = `${chunkPrefix}-${i}`;

    hierarchy[chunkKey] = {
      parent: null,
      children: []
    };

    if (chunk.level === 2) {
      currentH2Index = i;
    } else if (chunk.level === 3 && currentH2Index !== null) {
      const parentKey = `${chunkPrefix}-${currentH2Index}`;
      hierarchy[chunkKey].parent = parentKey;
      hierarchy[parentKey].children.push(chunkKey);
    }
  }

  return hierarchy;
}

function indexFile(db, filePath, keyPrefix) {
  const fileName = basename(filePath, extname(filePath));
  const docKey = `doc-${keyPrefix}-${fileName}`;
  const chunkPrefix = `chunk-${keyPrefix}-${fileName}`;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const contentHash = hashContent(content);

    // Check if content changed (skip if same hash unless --force)
    if (!force) {
      const existingHash = getEntryHash(db, docKey);
      if (existingHash === contentHash) {
        return { docKey, status: 'unchanged', chunks: 0 };
      }
    }

    const stats = statSync(filePath);
    const relativePath = '/' + relative(projectRoot, filePath).replace(/\\/g, '/');

    // Delete old chunks for this file before re-indexing
    deleteByPrefix(db, chunkPrefix);

    // 1. Store full document
    const docMetadata = {
      type: 'document',
      filePath: relativePath,
      fileSize: stats.size,
      lastModified: stats.mtime.toISOString(),
      contentHash,
      indexedAt: new Date().toISOString(),
      ragVersion: '2.0',  // Mark as full RAG indexed
    };

    storeEntry(db, docKey, content, docMetadata, [keyPrefix, 'document']);
    debug(`Stored document: ${docKey}`);

    // 2. Chunk and store semantic pieces with full RAG linking
    const chunks = chunkMarkdown(content, fileName);

    if (chunks.length === 0) {
      return { docKey, status: 'indexed', chunks: 0 };
    }

    // Build hierarchy and sibling list
    const hierarchy = buildHierarchy(chunks, chunkPrefix);
    const siblings = chunks.map((_, i) => `${chunkPrefix}-${i}`);

    // Update document with children references
    const docChildrenMeta = {
      ...docMetadata,
      children: siblings,
      chunkCount: chunks.length,
    };
    storeEntry(db, docKey, content, docChildrenMeta, [keyPrefix, 'document']);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkKey = `${chunkPrefix}-${i}`;

      // Build prev/next links
      const prevChunk = i > 0 ? `${chunkPrefix}-${i - 1}` : null;
      const nextChunk = i < chunks.length - 1 ? `${chunkPrefix}-${i + 1}` : null;

      // Extract overlapping context from adjacent chunks
      const contextBefore = i > 0
        ? extractOverlapContext(chunks[i - 1].content, overlapPercent, 'end')
        : null;
      const contextAfter = i < chunks.length - 1
        ? extractOverlapContext(chunks[i + 1].content, overlapPercent, 'start')
        : null;

      // Get hierarchical relationships
      const hierInfo = hierarchy[chunkKey];

      const chunkMetadata = {
        type: 'chunk',
        ragVersion: '2.0',

        // Document relationship
        parentDoc: docKey,
        parentPath: relativePath,

        // Sequential navigation (forward/backward links)
        chunkIndex: i,
        totalChunks: chunks.length,
        prevChunk,
        nextChunk,

        // Sibling awareness
        siblings,

        // Hierarchical relationships (h2 -> h3)
        hierarchicalParent: hierInfo.parent,
        hierarchicalChildren: hierInfo.children.length > 0 ? hierInfo.children : null,

        // Chunk info
        chunkTitle: chunk.title,
        headerLevel: chunk.level,
        headerLine: chunk.headerLine,
        isPart: chunk.isPart || false,
        partNum: chunk.partNum || null,

        // Overlapping context for continuity
        contextOverlapPercent: overlapPercent,
        hasContextBefore: !!contextBefore,
        hasContextAfter: !!contextAfter,

        // Content metadata
        contentLength: chunk.content.length,
        contentHash: hashContent(chunk.content),
        indexedAt: new Date().toISOString(),
      };

      // Build searchable content with title context
      // Include overlap context for better retrieval
      let searchableContent = `# ${chunk.title}\n\n`;

      if (contextBefore) {
        searchableContent += `[Context from previous section:]\n${contextBefore}\n\n---\n\n`;
      }

      searchableContent += chunk.content;

      if (contextAfter) {
        searchableContent += `\n\n---\n\n[Context from next section:]\n${contextAfter}`;
      }

      // Store chunk with full metadata
      storeEntry(
        db,
        chunkKey,
        searchableContent,
        chunkMetadata,
        [keyPrefix, 'chunk', `level-${chunk.level}`, chunk.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
      );

      debug(`  Stored chunk ${i}: ${chunk.title} (${chunk.content.length} chars, prev=${!!prevChunk}, next=${!!nextChunk})`);
    }

    return { docKey, status: 'indexed', chunks: chunks.length };
  } catch (err) {
    return { docKey, status: 'error', error: err.message, chunks: 0 };
  }
}

/**
 * Recursively collect all .md files under a directory.
 * Skips node_modules, .git, and other non-content directories.
 */
function walkMdFiles(dir) {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.reports']);
  // CLAUDE.md is loaded into context by Claude automatically — skip to avoid duplicate vectors
  const SKIP_FILES = new Set(['CLAUDE.md']);
  const files = [];

  function walk(current) {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(resolve(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
        files.push(resolve(current, entry.name));
      }
    }
  }

  walk(dir);
  return files;
}

function indexDirectory(db, dirConfig) {
  const dirPath = dirConfig.absolute ? dirConfig.path : resolve(projectRoot, dirConfig.path);
  const results = [];

  if (!existsSync(dirPath)) {
    if (verbose) debug(`Directory not found: ${dirConfig.path}`);
    return results;
  }

  const allMdFiles = walkMdFiles(dirPath);
  const filtered = dirConfig.fileFilter
    ? allMdFiles.filter(f => dirConfig.fileFilter.includes(basename(f)))
    : allMdFiles;

  for (const filePath of filtered) {
    const result = indexFile(db, filePath, dirConfig.prefix);
    results.push(result);
  }

  return results;
}

/**
 * Remove stale entries for files that no longer exist on disk.
 * Uses the set of docKeys seen during the current indexing run to determine
 * which entries are stale, rather than reconstructing file paths from keys
 * (which breaks for files in subdirectories).
 */
function cleanStaleEntries(db, currentDocKeys) {
  const docsStmt = db.prepare(
    `SELECT DISTINCT key FROM memory_entries WHERE namespace = ? AND key LIKE 'doc-%'`
  );
  docsStmt.bind([NAMESPACE]);
  const docs = [];
  while (docsStmt.step()) docs.push(docsStmt.getAsObject());
  docsStmt.free();

  let staleCount = 0;

  for (const { key } of docs) {
    // If this doc key was seen during the current indexing run, it's not stale
    if (currentDocKeys.has(key)) continue;

    const chunkPrefix = key.replace('doc-', 'chunk-');
    const countBefore = db.exec(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = '${NAMESPACE}'`)[0]?.values[0][0] || 0;
    db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key LIKE ?`, [NAMESPACE, `${chunkPrefix}%`]);
    db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key = ?`, [NAMESPACE, key]);
    const countAfter = db.exec(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = '${NAMESPACE}'`)[0]?.values[0][0] || 0;
    const removed = countBefore - countAfter;
    if (removed > 0) {
      log(`  Removed ${removed} stale entries for deleted file: ${key}`);
      staleCount += removed;
    }
  }

  // Also clean any orphaned entries not matching doc-/chunk- patterns
  const orphanStmt = db.prepare(
    `SELECT key FROM memory_entries WHERE namespace = ? AND key NOT LIKE 'doc-%' AND key NOT LIKE 'chunk-%'`
  );
  orphanStmt.bind([NAMESPACE]);
  const orphans = [];
  while (orphanStmt.step()) orphans.push(orphanStmt.getAsObject());
  orphanStmt.free();
  for (const { key } of orphans) {
    db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key = ?`, [NAMESPACE, key]);
    staleCount++;
    log(`  Removed orphan entry: ${key}`);
  }

  return staleCount;
}

// Main
console.log('');
log('Indexing guidance files with FULL RAG linked segments...');
log(`  Context overlap: ${overlapPercent}%`);
log(`  Directories (${GUIDANCE_DIRS.length}):`);
for (const d of GUIDANCE_DIRS) {
  const dirPath = d.absolute ? d.path : resolve(projectRoot, d.path);
  const exists = existsSync(dirPath);
  log(`    ${exists ? '✓' : '✗'} ${d.absolute ? dirPath : d.path} [${d.prefix}]`);
}
console.log('');

const db = await getDb();
let docsIndexed = 0;
let chunksIndexed = 0;
let unchanged = 0;
let errors = 0;
const currentDocKeys = new Set();

if (specificFile) {
  // Index single file
  const filePath = resolve(projectRoot, specificFile);
  if (!existsSync(filePath)) {
    log(`File not found: ${specificFile}`);
    process.exit(1);
  }

  let prefix = 'docs';
  if (specificFile.includes('.claude/guidance/')) {
    prefix = 'guidance';
  }

  const result = indexFile(db, filePath, prefix);
  log(`${result.docKey}: ${result.status} (${result.chunks} chunks)`);

  if (result.status === 'indexed') {
    docsIndexed++;
    chunksIndexed += result.chunks;
  } else if (result.status === 'unchanged') {
    unchanged++;
  } else {
    errors++;
  }
} else {
  // Index all directories
  for (const dir of GUIDANCE_DIRS) {
    log(`Scanning ${dir.path}/...`);
    const results = indexDirectory(db, dir);

    for (const result of results) {
      if (result.status === 'indexed' || result.status === 'unchanged') {
        currentDocKeys.add(result.docKey);
      }
      if (result.status === 'indexed') {
        log(`  ✅ ${result.docKey} (${result.chunks} chunks)`);
        docsIndexed++;
        chunksIndexed += result.chunks;
      } else if (result.status === 'unchanged') {
        unchanged++;
      } else {
        log(`  ❌ ${result.docKey}: ${result.error}`);
        errors++;
      }
    }
  }
}

// Clean stale entries for deleted files (unless indexing a specific file)
let staleRemoved = 0;
if (!specificFile) {
  log('Cleaning stale entries for deleted files...');
  staleRemoved = cleanStaleEntries(db, currentDocKeys);
  if (staleRemoved === 0) {
    log('  No stale entries found');
  }
}

// Write changes back to disk
if (docsIndexed > 0 || chunksIndexed > 0 || staleRemoved > 0) saveDb(db);

// Check for entries missing embeddings (e.g. prior background run failed)
let missingEmbeddings = 0;
{
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = ? AND (embedding IS NULL OR embedding = '')`);
  stmt.bind([NAMESPACE]);
  if (stmt.step()) missingEmbeddings = stmt.getAsObject().cnt;
  stmt.free();
}
db.close();

console.log('');
log('═══════════════════════════════════════════════════════════');
log('  FULL RAG INDEXING COMPLETE');
log('═══════════════════════════════════════════════════════════');
log(`  Documents indexed:    ${docsIndexed}`);
log(`  Chunks created:       ${chunksIndexed}`);
log(`  Unchanged:            ${unchanged}`);
log(`  Stale removed:        ${staleRemoved}`);
log(`  Errors:               ${errors}`);
log('');
log('  RAG Features Enabled:');
log(`    • Forward/backward links (prevChunk/nextChunk)`);
log(`    • Sibling awareness (all chunks from same doc)`);
log(`    • Hierarchical links (h2 -> h3 parent/children)`);
log(`    • Context overlap: ${overlapPercent}% (contextBefore/contextAfter)`);
log('═══════════════════════════════════════════════════════════');

// Generate embeddings for new entries or backfill missing ones
// Runs in BACKGROUND to avoid blocking startup
const needsEmbeddings = (docsIndexed > 0 || chunksIndexed > 0 || missingEmbeddings > 0);
if (!skipEmbeddings && needsEmbeddings) {
  if (missingEmbeddings > 0 && docsIndexed === 0 && chunksIndexed === 0) {
    log(`${missingEmbeddings} entries missing embeddings — backfilling...`);
  }
  console.log('');
  log('Spawning embedding generation in background...');

  const { spawn } = await import('child_process');

  // Look for build-embeddings script in multiple locations:
  // 1. Shipped with moflo (node_modules/moflo/bin/)
  // 2. Project-local (.claude/scripts/)
  const mofloScript = resolve(__dirname, 'build-embeddings.mjs');
  const projectLocalScript = resolve(projectRoot, '.claude/scripts/build-embeddings.mjs');
  const embeddingScript = existsSync(mofloScript) ? mofloScript : projectLocalScript;

  if (existsSync(embeddingScript)) {
    const embeddingArgs = ['--namespace', NAMESPACE];

    // Create log file for background process output
    const logDir = resolve(projectRoot, '.swarm/logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const logFile = resolve(logDir, 'embeddings.log');
    const { openSync } = await import('fs');
    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');

    // Spawn in background - don't wait for completion
    const proc = spawn('node', [embeddingScript, ...embeddingArgs], {
      stdio: ['ignore', out, err],
      cwd: projectRoot,
      detached: true,
      windowsHide: true  // Suppress command windows on Windows
    });
    proc.unref();  // Allow parent to exit independently

    log(`Background embedding started (PID: ${proc.pid})`);
    log(`Log file: .swarm/logs/embeddings.log`);
  } else {
    log('⚠️  Embedding script not found, skipping embedding generation');
  }
} else if (skipEmbeddings) {
  log('Skipping embedding generation (--no-embeddings)');
} else {
  log('No new content indexed, skipping embedding generation');
}

if (errors > 0) {
  process.exit(1);
}
