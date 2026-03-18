#!/usr/bin/env node
/**
 * Generate embeddings for all memory entries and build HNSW index
 *
 * Embedding Strategy (in order of preference):
 * 1. Transformers.js with all-MiniLM-L6-v2 (best quality, requires sharp)
 * 2. Domain-aware semantic hash embeddings (fast, good quality, no deps)
 *
 * The domain-aware hash embeddings use:
 * - Domain clustering for semantic grouping (database, frontend, backend, testing, etc.)
 * - SimHash-style word encoding with multiple hash positions
 * - N-gram features (bigrams, trigrams) for phrase detection
 * - L2 normalization for cosine similarity
 *
 * Usage:
 *   node node_modules/moflo/bin/build-embeddings.mjs           # Embed entries without embeddings
 *   npx moflo-embeddings --force                               # Re-embed all entries
 *   npx moflo-embeddings --namespace guidance                   # Only specific namespace
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import initSqlJs from 'sql.js';

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

const DB_PATH = resolve(projectRoot, '.swarm/memory.db');

// Embedding config
const EMBEDDING_MODEL_NEURAL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_MODEL_HASH = 'domain-aware-hash-v1';
const EMBEDDING_DIMS = 384;
const BATCH_SIZE = 100;

// Parse args
const args = process.argv.slice(2);
const force = args.includes('--force');
const namespaceFilter = args.includes('--namespace')
  ? args[args.indexOf('--namespace') + 1]
  : null;
const verbose = args.includes('--verbose') || args.includes('-v');

let pipeline = null;
let useTransformers = false;
let embeddingModel = EMBEDDING_MODEL_HASH;

function log(msg) {
  console.log(`[build-embeddings] ${msg}`);
}

function debug(msg) {
  if (verbose) console.log(`[build-embeddings]   ${msg}`);
}

// ============================================================================
// Domain-Aware Semantic Hash Embeddings
// ============================================================================

// Domain clusters for semantic grouping
const DOMAIN_CLUSTERS = {
  database: ['typeorm', 'mongodb', 'database', 'entity', 'schema', 'table', 'collection',
             'query', 'sql', 'nosql', 'orm', 'model', 'migration', 'repository', 'column',
             'relation', 'foreign', 'primary', 'index', 'constraint', 'transaction'],
  frontend: ['react', 'component', 'ui', 'styling', 'css', 'html', 'jsx', 'tsx', 'frontend',
             'material', 'mui', 'tailwind', 'dom', 'render', 'hook', 'state', 'props',
             'redux', 'context', 'styled', 'emotion', 'theme', 'layout', 'responsive'],
  backend: ['fastify', 'api', 'route', 'handler', 'rest', 'endpoint', 'server', 'controller',
            'middleware', 'request', 'response', 'http', 'express', 'nest', 'graphql',
            'websocket', 'socket', 'cors', 'auth', 'jwt', 'session', 'cookie'],
  testing: ['test', 'testing', 'vitest', 'jest', 'mock', 'spy', 'assert', 'expect', 'describe',
            'it', 'spec', 'unit', 'integration', 'e2e', 'playwright', 'cypress', 'coverage',
            'fixture', 'stub', 'fake', 'snapshot', 'beforeeach', 'aftereach'],
  tenancy: ['tenant', 'tenancy', 'companyid', 'company', 'isolation', 'multi', 'multitenant',
            'organization', 'workspace', 'account', 'customer', 'client'],
  security: ['security', 'auth', 'authentication', 'authorization', 'permission', 'role',
             'access', 'token', 'jwt', 'oauth', 'password', 'encrypt', 'hash', 'salt',
             'csrf', 'xss', 'injection', 'sanitize', 'validate'],
  patterns: ['pattern', 'service', 'factory', 'singleton', 'decorator', 'adapter', 'facade',
             'observer', 'strategy', 'command', 'repository', 'usecase', 'domain', 'ddd',
             'clean', 'architecture', 'solid', 'dry', 'kiss'],
  workflow: ['workflow', 'pipeline', 'ci', 'cd', 'deploy', 'build', 'actions',
             'hook', 'trigger', 'job', 'step', 'artifact', 'release', 'version', 'tag'],
  memory: ['memory', 'cache', 'store', 'persist', 'storage', 'redis', 'session', 'state',
           'buffer', 'queue', 'stack', 'heap', 'gc', 'leak', 'embedding', 'vector', 'hnsw',
           'semantic', 'search', 'index', 'retrieval'],
  agent: ['agent', 'swarm', 'coordinator', 'orchestrator', 'task', 'worker', 'spawn',
          'parallel', 'concurrent', 'async', 'promise', 'queue', 'priority', 'schedule'],
  github: ['github', 'issue', 'branch', 'pr', 'pull', 'request', 'merge', 'commit', 'push',
           'clone', 'fork', 'remote', 'origin', 'main', 'master', 'checkout', 'rebase',
           'squash', 'repository', 'repo', 'gh', 'git', 'assignee', 'label', 'mandatory',
           'checklist', 'closes', 'fixes', 'conventional', 'feat', 'refactor'],
  documentation: ['guidance', 'documentation', 'docs', 'readme', 'guide', 'tutorial',
                  'reference', 'standard', 'convention', 'rule', 'policy', 'template',
                  'example', 'usage', 'instruction', 'meta', 'index', 'umbrella', 'claude',
                  'optimized', 'audience', 'structure', 'format', 'markdown']
};

// Common words to downweight
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'can', 'need', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'and', 'but',
  'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'not', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'also', 'this', 'that', 'these', 'those', 'it', 'its', 'if', 'then',
  'else', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'any', 'some', 'no', 'yes',
  'use', 'using', 'used', 'uses', 'get', 'set', 'new', 'see', 'like', 'make', 'made'
]);

// MurmurHash3-inspired hash function for better distribution
function hash(str, seed = 0) {
  let h = seed ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// Pre-compute domain signature vectors
const domainSignatures = {};
for (const [domain, keywords] of Object.entries(DOMAIN_CLUSTERS)) {
  const sig = new Float32Array(EMBEDDING_DIMS);
  for (const kw of keywords) {
    // Use multiple positions per keyword for robustness
    for (let h = 0; h < 2; h++) {
      const idx = hash(kw + '_dom_' + domain, h) % EMBEDDING_DIMS;
      sig[idx] = 1;
    }
  }
  domainSignatures[domain] = sig;
}

/**
 * Generate domain-aware semantic hash embedding
 * @param {string} text - Text to embed
 * @param {number} dims - Embedding dimensions
 * @returns {Float32Array} - Normalized embedding vector
 */
function semanticHashEmbed(text, dims = EMBEDDING_DIMS) {
  const vec = new Float32Array(dims);
  const lowerText = text.toLowerCase();
  const words = lowerText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);

  if (words.length === 0) {
    // Empty text - return zero vector (will have low similarity to everything)
    return vec;
  }

  // 1. Add domain signatures for matched domains
  for (const [domain, keywords] of Object.entries(DOMAIN_CLUSTERS)) {
    let matchCount = 0;
    for (const kw of keywords) {
      if (lowerText.includes(kw)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      const weight = Math.min(2.0, 0.5 + matchCount * 0.3); // More matches = stronger signal
      const sig = domainSignatures[domain];
      for (let i = 0; i < dims; i++) {
        vec[i] += sig[i] * weight;
      }
    }
  }

  // 2. Add word features (simhash-style with multiple positions)
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const isCommon = COMMON_WORDS.has(word);
    const weight = isCommon ? 0.2 : (word.length > 6 ? 0.8 : 0.5);

    // Multiple hash positions per word
    for (let h = 0; h < 3; h++) {
      const idx = hash(word, h * 17) % dims;
      const sign = (hash(word, h * 31 + 1) % 2 === 0) ? 1 : -1;
      vec[idx] += sign * weight;
    }
  }

  // 3. Add bigram features for local context
  for (let i = 0; i < words.length - 1; i++) {
    if (COMMON_WORDS.has(words[i]) && COMMON_WORDS.has(words[i + 1])) continue;
    const bigram = words[i] + '_' + words[i + 1];
    const idx = hash(bigram, 42) % dims;
    const sign = (hash(bigram, 43) % 2 === 0) ? 1 : -1;
    vec[idx] += sign * 0.4;
  }

  // 4. Add trigram features for phrase detection
  for (let i = 0; i < words.length - 2; i++) {
    const trigram = words[i] + '_' + words[i + 1] + '_' + words[i + 2];
    const idx = hash(trigram, 99) % dims;
    const sign = (hash(trigram, 100) % 2 === 0) ? 1 : -1;
    vec[idx] += sign * 0.3;
  }

  // 5. L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) vec[i] /= norm;
  }

  return vec;
}

// ============================================================================
// Transformers.js Neural Embeddings (fallback)
// ============================================================================

async function loadTransformersModel() {
  if (pipeline) return pipeline;

  log('Attempting to load Transformers.js neural model...');

  try {
    const { env, pipeline: createPipeline } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    env.backends.onnx.wasm.numThreads = 1;

    pipeline = await createPipeline('feature-extraction', EMBEDDING_MODEL_NEURAL, {
      quantized: false,
    });

    useTransformers = true;
    embeddingModel = EMBEDDING_MODEL_NEURAL;
    log('Transformers.js model loaded successfully');
    return pipeline;
  } catch (err) {
    const errMsg = err.message?.split('\n')[0] || err.message;
    log(`Transformers.js not available: ${errMsg}`);
    log('Using domain-aware hash embeddings (fast, good quality)');
    useTransformers = false;
    embeddingModel = EMBEDDING_MODEL_HASH;
    return null;
  }
}

async function generateEmbeddingNeural(text) {
  if (!pipeline) return null;
  try {
    const output = await pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch {
    return null;
  }
}

// ============================================================================
// Database Operations
// ============================================================================

async function getDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found: ${DB_PATH}`);
  }
  const SQL = await initSqlJs();
  const buffer = readFileSync(DB_PATH);
  return new SQL.Database(buffer);
}

function saveDb(db) {
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

function getEntriesNeedingEmbeddings(db, namespace = null, forceAll = false) {
  let sql = `SELECT id, key, namespace, content FROM memory_entries WHERE status = 'active'`;
  const params = [];

  if (!forceAll) {
    sql += ` AND (embedding IS NULL OR embedding = '')`;
  }

  if (namespace) {
    sql += ` AND namespace = ?`;
    params.push(namespace);
  }

  sql += ` ORDER BY created_at DESC`;

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function updateEmbedding(db, id, embedding, model) {
  const stmt = db.prepare(
    `UPDATE memory_entries SET embedding = ?, embedding_model = ?, embedding_dimensions = ?, updated_at = ? WHERE id = ?`
  );
  stmt.run([JSON.stringify(embedding), model, EMBEDDING_DIMS, Date.now(), id]);
  stmt.free();
}

function getEmbeddingStats(db) {
  const stmtTotal = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`);
  const total = stmtTotal.step() ? stmtTotal.getAsObject() : { cnt: 0 };
  stmtTotal.free();

  const stmtEmbed = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''`);
  const withEmbed = stmtEmbed.step() ? stmtEmbed.getAsObject() : { cnt: 0 };
  stmtEmbed.free();

  const stmtModel = db.prepare(`SELECT embedding_model, COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL GROUP BY embedding_model`);
  const byModel = [];
  while (stmtModel.step()) byModel.push(stmtModel.getAsObject());
  stmtModel.free();

  return {
    total: total?.cnt || 0,
    withEmbeddings: withEmbed?.cnt || 0,
    byModel
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('');
  log('═══════════════════════════════════════════════════════════');
  log('  Embedding Generation for Memory Entries');
  log('═══════════════════════════════════════════════════════════');
  console.log('');

  const db = await getDb();

  // Get entries needing embeddings
  const entries = getEntriesNeedingEmbeddings(db, namespaceFilter, force);

  if (entries.length === 0) {
    log('All entries already have embeddings');
    const stats = getEmbeddingStats(db);
    log(`Total: ${stats.withEmbeddings}/${stats.total} entries embedded`);
    db.close();
    return;
  }

  log(`Found ${entries.length} entries to embed`);

  // Try to load Transformers.js, fall back to hash embeddings
  await loadTransformersModel();

  log(`Using embedding model: ${embeddingModel}`);
  console.log('');

  let embedded = 0;
  let failed = 0;
  const startTime = Date.now();

  // Process entries
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    try {
      // Truncate content for embedding (first 1500 chars for context)
      const text = entry.content.substring(0, 1500);

      let embedding;
      if (useTransformers && pipeline) {
        embedding = await generateEmbeddingNeural(text);
      }

      // Fall back to hash embedding if neural failed or not available
      if (!embedding || embedding.length !== EMBEDDING_DIMS) {
        embedding = Array.from(semanticHashEmbed(text));
      }

      if (embedding && embedding.length === EMBEDDING_DIMS) {
        updateEmbedding(db, entry.id, embedding, embeddingModel);
        embedded++;
      } else {
        failed++;
      }

      // Progress update
      if ((i + 1) % 50 === 0 || i === entries.length - 1) {
        const pct = Math.round(((i + 1) / entries.length) * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`\r[build-embeddings] Progress: ${i + 1}/${entries.length} (${pct}%) - ${elapsed}s elapsed`);
      }
    } catch (err) {
      debug(`Failed to embed ${entry.key}: ${err.message}`);
      failed++;
    }
  }

  console.log(''); // New line after progress

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const stats = getEmbeddingStats(db);

  // Write changes back to disk (sql.js operates in-memory)
  if (embedded > 0) saveDb(db);
  db.close();

  console.log('');
  log('═══════════════════════════════════════════════════════════');
  log('  Embedding Generation Complete');
  log('═══════════════════════════════════════════════════════════');
  log(`  Embedded:     ${embedded} entries`);
  log(`  Failed:       ${failed} entries`);
  log(`  Time:         ${totalTime}s`);
  log(`  Model:        ${embeddingModel}`);
  log(`  Dimensions:   ${EMBEDDING_DIMS}`);
  log('');
  log(`  Total Coverage: ${stats.withEmbeddings}/${stats.total} entries`);
  if (stats.byModel.length > 0) {
    log('  By Model:');
    for (const m of stats.byModel) {
      log(`    - ${m.embedding_model}: ${m.cnt}`);
    }
  }
  log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
