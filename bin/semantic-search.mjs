#!/usr/bin/env node
/**
 * Semantic search over stored moflo memory entries.
 *
 * Query embeddings are produced by fastembed (`fast-all-MiniLM-L6-v2`,
 * 384-dim, L2-normalised). This matches `bin/build-embeddings.mjs` and the
 * in-process `FastembedEmbeddingService` so all three share a vector space.
 *
 * Neural embeddings are required — epic #527 removed every hash fallback.
 * If the model cannot load, the script reports the error and exits 1.
 *
 * Usage:
 *   node node_modules/moflo/bin/semantic-search.mjs "your search query"
 *   flo-search "your search query"
 *   flo-search "query" --limit 10
 *   flo-search "query" --namespace guidance
 *   flo-search "query" --threshold 0.3
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { mofloResolveURL } from './lib/moflo-resolve.mjs';
const initSqlJs = (await import(mofloResolveURL('sql.js'))).default;

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

const EMBEDDING_MODEL = 'fast-all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;
// Legacy aliases share the same vector space (all-MiniLM-L6-v2 regardless of
// runtime), so entries tagged with these model names are still valid search
// candidates against fastembed-generated query vectors.
const COMPATIBLE_MODELS = new Set([
  EMBEDDING_MODEL,
  'Xenova/all-MiniLM-L6-v2',
  'onnx',
]);

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith('--'));
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 5;
const namespace = args.includes('--namespace') ? args[args.indexOf('--namespace') + 1] : null;
const withTests = args.includes('--with-tests');
const threshold = args.includes('--threshold') ? parseFloat(args[args.indexOf('--threshold') + 1]) : 0.3;
const json = args.includes('--json');
const debug = args.includes('--debug');

const TEST_KEYWORDS = /\b(test|spec|coverage|assert|mock|stub|fixture|describe|jest|vitest|mocha|e2e|integration test)\b/i;

if (!query) {
  console.error('Usage: flo-search "your query" [--limit N] [--namespace X] [--threshold N]');
  process.exit(1);
}

// ============================================================================
// Fastembed loader — neural embeddings are required, no fallback
// ============================================================================

let fastembedModel = null;

async function loadModel() {
  if (fastembedModel) return fastembedModel;

  const mod = await import(mofloResolveURL('fastembed'));
  const { FlagEmbedding, EmbeddingModel } = mod;

  fastembedModel = await FlagEmbedding.init({
    model: EmbeddingModel.AllMiniLML6V2,
    showDownloadProgress: false,
  });
  if (debug) console.error('[semantic-search] fastembed model loaded');
  return fastembedModel;
}

async function generateQueryEmbedding(text) {
  const model = await loadModel();
  const vec = await model.queryEmbed(text);
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
    throw new Error(`fastembed returned unexpected vector shape (got length ${vec?.length ?? 'none'})`);
  }
  return vec;
}

// ============================================================================
// Search
// ============================================================================

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalised on both sides
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
  const { limit = 5, namespace: ns = null, threshold: th = 0.3 } = options;
  const startTime = performance.now();

  const db = await getDb();
  const queryEmbedding = await generateQueryEmbedding(queryText);

  let sql = `
    SELECT id, key, namespace, content, embedding, embedding_model, metadata
    FROM memory_entries
    WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''
  `;
  const params = [];
  if (ns) {
    sql += ` AND namespace = ?`;
    params.push(ns);
  }

  const stmt = db.prepare(sql);
  stmt.bind(params);

  const results = [];
  let skippedIncompat = 0;
  while (stmt.step()) {
    const entry = stmt.getAsObject();
    try {
      if (entry.embedding_model && !COMPATIBLE_MODELS.has(entry.embedding_model)) {
        skippedIncompat++;
        continue;
      }

      const embedding = JSON.parse(entry.embedding);
      if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) continue;

      const similarity = cosineSimilarity(queryEmbedding, embedding);
      if (similarity < th) continue;

      let metadata = {};
      try {
        metadata = JSON.parse(entry.metadata || '{}');
      } catch (err) {
        if (debug) console.error(`[semantic-search] metadata parse failed for ${entry.key}: ${err.message}`);
      }

      results.push({
        key: entry.key,
        namespace: entry.namespace,
        score: similarity,
        preview: entry.content.substring(0, 150).replace(/\n/g, ' '),
        type: metadata.type || 'unknown',
        parentDoc: metadata.parentDoc || null,
        chunkTitle: metadata.chunkTitle || null,
      });
    } catch (err) {
      if (debug) console.error(`[semantic-search] skipped ${entry.key}: ${err.message}`);
    }
  }
  stmt.free();
  db.close();

  if (debug && skippedIncompat > 0) {
    console.error(`[semantic-search] Skipped ${skippedIncompat} rows with incompatible embedding_model`);
  }

  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);
  const searchTime = performance.now() - startTime;

  return {
    query: queryText,
    results: topResults,
    totalMatches: results.length,
    searchTime: `${searchTime.toFixed(0)}ms`,
    indexType: 'vector-cosine',
    model: EMBEDDING_MODEL,
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
    const autoRouteTests = !namespace && TEST_KEYWORDS.test(query);
    let results;

    if (withTests || autoRouteTests) {
      const primaryNs = namespace || 'code-map';
      const primaryResults = await semanticSearch(query, { limit, namespace: primaryNs, threshold });
      const testResults = await semanticSearch(query, { limit, namespace: 'tests', threshold });

      const merged = [...primaryResults.results, ...testResults.results]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      results = {
        ...primaryResults,
        results: merged,
        totalMatches: primaryResults.totalMatches + testResults.totalMatches,
        searchTime: `${parseInt(primaryResults.searchTime) + parseInt(testResults.searchTime)}ms`,
        namespaces: [primaryNs, 'tests'],
      };

      if (!json && autoRouteTests) {
        console.log('[semantic-search] Auto-routed to tests namespace (query contains test keywords)');
      }
    } else {
      results = await semanticSearch(query, { limit, namespace, threshold });
    }

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
