#!/usr/bin/env node
/**
 * Semantic search using 384-dim embeddings (Xenova/all-MiniLM-L6-v2 or hash fallback)
 *
 * Query embedding MUST match stored embedding model:
 * 1. Transformers.js with all-MiniLM-L6-v2 (best quality, matches build-embeddings)
 * 2. Domain-aware semantic hash embeddings (fallback when transformers unavailable)
 *
 * Usage:
 *   node node_modules/moflo/bin/semantic-search.mjs "your search query"
 *   npx moflo-search "your search query"
 *   npx moflo-search "query" --limit 10
 *   npx moflo-search "query" --namespace guidance
 *   npx moflo-search "query" --threshold 0.3
 */

import { existsSync, readFileSync } from 'fs';
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
const EMBEDDING_DIMS = 384;
const EMBEDDING_MODEL_NEURAL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_MODEL_HASH = 'domain-aware-hash-v1';

// Parse args
const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 5;
const namespace = args.includes('--namespace') ? args[args.indexOf('--namespace') + 1] : null;
const threshold = args.includes('--threshold') ? parseFloat(args[args.indexOf('--threshold') + 1]) : 0.3;
const json = args.includes('--json');
const debug = args.includes('--debug');

if (!query) {
  console.error('Usage: npx moflo-search "your query" [--limit N] [--namespace X] [--threshold N]');
  process.exit(1);
}

// ============================================================================
// Transformers.js Neural Embeddings (primary — matches build-embeddings.mjs)
// ============================================================================

let pipeline = null;
let useTransformers = false;

async function loadTransformersModel() {
  try {
    const { env, pipeline: createPipeline } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    env.backends.onnx.wasm.numThreads = 1;

    pipeline = await createPipeline('feature-extraction', EMBEDDING_MODEL_NEURAL, {
      quantized: false,
    });

    useTransformers = true;
    if (debug) console.error('[semantic-search] Using Transformers.js neural model');
    return true;
  } catch (err) {
    if (debug) console.error(`[semantic-search] Transformers.js unavailable: ${err.message?.split('\n')[0]}`);
    useTransformers = false;
    return false;
  }
}

async function generateNeuralEmbedding(text) {
  if (!pipeline) return null;
  try {
    const output = await pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch {
    return null;
  }
}

// ============================================================================
// Domain-Aware Semantic Hash Embeddings (fallback)
// ============================================================================

const DOMAIN_CLUSTERS = {
  database: ['typeorm', 'mongodb', 'database', 'entity', 'schema', 'table', 'collection',
             'query', 'sql', 'nosql', 'orm', 'model', 'migration', 'repository', 'column',
             'relation', 'foreign', 'primary', 'index', 'constraint', 'transaction',
             'mikroorm', 'mikro', 'postgresql', 'postgres', 'soft', 'delete', 'deletedat'],
  frontend: ['react', 'component', 'ui', 'styling', 'css', 'html', 'jsx', 'tsx', 'frontend',
             'material', 'mui', 'tailwind', 'dom', 'render', 'hook', 'state', 'props',
             'redux', 'context', 'styled', 'emotion', 'theme', 'layout', 'responsive',
             'mantis', 'syncfusion', 'scheduler', 'i18n', 'intl', 'locale'],
  backend: ['fastify', 'api', 'route', 'handler', 'rest', 'endpoint', 'server', 'controller',
            'middleware', 'request', 'response', 'http', 'express', 'nest', 'graphql',
            'websocket', 'socket', 'cors', 'auth', 'jwt', 'session', 'cookie',
            'awilix', 'dependency', 'injection', 'scope'],
  testing: ['test', 'testing', 'vitest', 'jest', 'mock', 'spy', 'assert', 'expect', 'describe',
            'it', 'spec', 'unit', 'integration', 'e2e', 'playwright', 'cypress', 'coverage',
            'fixture', 'stub', 'fake', 'snapshot', 'beforeeach', 'aftereach',
            'anti-pattern', 'antipattern', 'mocking'],
  tenancy: ['tenant', 'tenancy', 'companyid', 'company', 'isolation', 'multi', 'multitenant',
            'organization', 'workspace', 'account', 'customer', 'client', 'subdomain'],
  security: ['security', 'auth', 'authentication', 'authorization', 'permission', 'role',
             'access', 'token', 'jwt', 'oauth', 'password', 'encrypt', 'hash', 'salt',
             'csrf', 'xss', 'injection', 'sanitize', 'validate', 'rbac'],
  patterns: ['pattern', 'service', 'factory', 'singleton', 'decorator', 'adapter', 'facade',
             'observer', 'strategy', 'command', 'repository', 'usecase', 'domain', 'ddd',
             'clean', 'architecture', 'solid', 'dry', 'kiss', 'functional', 'pipeasync'],
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

function hash(str, seed = 0) {
  let h = seed ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// Pre-compute domain signatures
const domainSignatures = {};
for (const [domain, keywords] of Object.entries(DOMAIN_CLUSTERS)) {
  const sig = new Float32Array(EMBEDDING_DIMS);
  for (const kw of keywords) {
    for (let h = 0; h < 2; h++) {
      const idx = hash(kw + '_dom_' + domain, h) % EMBEDDING_DIMS;
      sig[idx] = 1;
    }
  }
  domainSignatures[domain] = sig;
}

function semanticHashEmbed(text, dims = EMBEDDING_DIMS) {
  const vec = new Float32Array(dims);
  const lowerText = text.toLowerCase();
  const words = lowerText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);

  if (words.length === 0) return vec;

  // Add domain signatures
  for (const [domain, keywords] of Object.entries(DOMAIN_CLUSTERS)) {
    let matchCount = 0;
    for (const kw of keywords) {
      if (lowerText.includes(kw)) matchCount++;
    }
    if (matchCount > 0) {
      const weight = Math.min(2.0, 0.5 + matchCount * 0.3);
      const sig = domainSignatures[domain];
      for (let i = 0; i < dims; i++) {
        vec[i] += sig[i] * weight;
      }
    }
  }

  // Add word features
  for (const word of words) {
    const isCommon = COMMON_WORDS.has(word);
    const weight = isCommon ? 0.2 : (word.length > 6 ? 0.8 : 0.5);
    for (let h = 0; h < 3; h++) {
      const idx = hash(word, h * 17) % dims;
      const sign = (hash(word, h * 31 + 1) % 2 === 0) ? 1 : -1;
      vec[idx] += sign * weight;
    }
  }

  // Add bigrams
  for (let i = 0; i < words.length - 1; i++) {
    if (COMMON_WORDS.has(words[i]) && COMMON_WORDS.has(words[i + 1])) continue;
    const bigram = words[i] + '_' + words[i + 1];
    const idx = hash(bigram, 42) % dims;
    const sign = (hash(bigram, 43) % 2 === 0) ? 1 : -1;
    vec[idx] += sign * 0.4;
  }

  // Add trigrams
  for (let i = 0; i < words.length - 2; i++) {
    const trigram = words[i] + '_' + words[i + 1] + '_' + words[i + 2];
    const idx = hash(trigram, 99) % dims;
    const sign = (hash(trigram, 100) % 2 === 0) ? 1 : -1;
    vec[idx] += sign * 0.3;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) vec[i] /= norm;
  }

  return vec;
}

// ============================================================================
// Unified Embedding Generator (matches stored embeddings)
// ============================================================================

/**
 * Generate query embedding using the SAME model as stored embeddings.
 * Checks what model was used for stored entries and matches it.
 */
async function generateQueryEmbedding(queryText, db) {
  // Check what model the stored entries use
  let modelCheckSql = `SELECT embedding_model, COUNT(*) as cnt FROM memory_entries
     WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''
     ${namespace ? "AND namespace = ?" : ""}
     GROUP BY embedding_model ORDER BY cnt DESC LIMIT 1`;
  const modelStmt = db.prepare(modelCheckSql);
  modelStmt.bind(namespace ? [namespace] : []);
  const modelCheck = modelStmt.step() ? modelStmt.getAsObject() : null;
  modelStmt.free();

  const storedModel = modelCheck?.embedding_model || EMBEDDING_MODEL_HASH;

  if (debug) console.error(`[semantic-search] Stored model: ${storedModel}`);

  // If stored embeddings are neural, try to use neural for query too
  if (storedModel === EMBEDDING_MODEL_NEURAL) {
    await loadTransformersModel();
    if (useTransformers) {
      const neuralEmb = await generateNeuralEmbedding(queryText);
      if (neuralEmb && neuralEmb.length === EMBEDDING_DIMS) {
        return { embedding: neuralEmb, model: EMBEDDING_MODEL_NEURAL };
      }
    }
    // Neural failed — warn about model mismatch
    if (!json) {
      console.error('[semantic-search] WARNING: Stored embeddings use neural model but Transformers.js unavailable.');
      console.error('[semantic-search] Results may be poor. Run: npx moflo-embeddings --force');
    }
  }

  // Use hash embeddings (either matching stored hash model, or as fallback)
  const hashEmb = Array.from(semanticHashEmbed(queryText));
  return { embedding: hashEmb, model: EMBEDDING_MODEL_HASH };
}

// ============================================================================
// Search Functions
// ============================================================================

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // Already L2 normalized
}

async function getDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found: ${DB_PATH}`);
  }
  const SQL = await initSqlJs();
  const buffer = readFileSync(DB_PATH);
  return new SQL.Database(buffer);
}

async function semanticSearch(queryText, options = {}) {
  const { limit = 5, namespace = null, threshold = 0.3 } = options;
  const startTime = performance.now();

  const db = await getDb();

  // Generate query embedding matching the stored model
  const { embedding: queryEmbedding, model: queryModel } = await generateQueryEmbedding(queryText, db);

  if (debug) console.error(`[semantic-search] Query model: ${queryModel}`);

  // Get all entries with embeddings
  let sql = `
    SELECT id, key, namespace, content, embedding, embedding_model, metadata
    FROM memory_entries
    WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''
  `;
  const params = [];

  if (namespace) {
    sql += ` AND namespace = ?`;
    params.push(namespace);
  }

  const stmt = db.prepare(sql);
  stmt.bind(params);

  // Calculate similarity scores
  const results = [];
  while (stmt.step()) {
    const entry = stmt.getAsObject();
    try {
      // Skip entries with mismatched embedding model (incompatible vector spaces)
      if (entry.embedding_model && entry.embedding_model !== queryModel) continue;

      const embedding = JSON.parse(entry.embedding);
      if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) continue;

      const similarity = cosineSimilarity(queryEmbedding, embedding);

      if (similarity >= threshold) {
        let metadata = {};
        try {
          metadata = JSON.parse(entry.metadata || '{}');
        } catch {}

        results.push({
          key: entry.key,
          namespace: entry.namespace,
          score: similarity,
          preview: entry.content.substring(0, 150).replace(/\n/g, ' '),
          type: metadata.type || 'unknown',
          parentDoc: metadata.parentDoc || null,
          chunkTitle: metadata.chunkTitle || null,
        });
      }
    } catch {
      // Skip entries with invalid embeddings
    }
  }
  stmt.free();

  db.close();

  // Sort by similarity (descending) and limit
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);

  const searchTime = performance.now() - startTime;

  return {
    query: queryText,
    results: topResults,
    totalMatches: results.length,
    searchTime: `${searchTime.toFixed(0)}ms`,
    indexType: 'vector-cosine',
    model: queryModel,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (!json) {
    console.log('');
    console.log(`[semantic-search] Query: "${query}"`);
  }

  try {
    const results = await semanticSearch(query, { limit, namespace, threshold });

    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log(`[semantic-search] Found ${results.totalMatches} matches (${results.searchTime}) [${results.model}]`);
    console.log('');

    if (results.results.length === 0) {
      console.log('No results found above threshold. Try lowering --threshold or broadening your query.');
      return;
    }

    // Display results
    console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
    console.log('│ Rank │ Score │ Key                          │ Type   │ Preview             │');
    console.log('├─────────────────────────────────────────────────────────────────────────────┤');

    for (let i = 0; i < results.results.length; i++) {
      const r = results.results[i];
      const rank = String(i + 1).padStart(4);
      const score = r.score.toFixed(3);
      const key = r.key.substring(0, 28).padEnd(28);
      const type = (r.type || '').substring(0, 6).padEnd(6);
      const preview = r.preview.substring(0, 18).padEnd(18);

      console.log(`│ ${rank} │ ${score} │ ${key} │ ${type} │ ${preview}… │`);
    }

    console.log('└─────────────────────────────────────────────────────────────────────────────┘');

    // Show chunk context
    console.log('');
    console.log('Top result details:');
    const top = results.results[0];
    console.log(`  Key: ${top.key}`);
    console.log(`  Score: ${top.score.toFixed(4)}`);
    if (top.chunkTitle) console.log(`  Section: ${top.chunkTitle}`);
    if (top.parentDoc) console.log(`  Parent: ${top.parentDoc}`);
    console.log(`  Preview: ${top.preview}...`);

  } catch (err) {
    console.error(`[semantic-search] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
