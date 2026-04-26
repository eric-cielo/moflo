#!/usr/bin/env node
/**
 * Generate neural embeddings for memory entries and invalidate the HNSW index.
 *
 * Neural embeddings are required — epic #527 removed every hash fallback. If
 * the fastembed model cannot load (missing download, broken network, etc.)
 * this script exits non-zero rather than silently degrading to hashed vectors.
 *
 * Model: `fast-all-MiniLM-L6-v2` via the `fastembed` npm package (384 dims,
 * L2-normalised). Matches the shape and vector space of entries embedded by
 * cli's `FastembedEmbeddingService`.
 *
 * Usage:
 *   node node_modules/moflo/bin/build-embeddings.mjs          # embed rows with no embedding
 *   flo-embeddings --force                                    # re-embed every row
 *   flo-embeddings --namespace guidance                       # scope to one namespace
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { mofloResolveURL, mofloInternalURL } from './lib/moflo-resolve.mjs';
const initSqlJs = (await import(mofloResolveURL('sql.js'))).default;
const FASTEMBED_INLINE = 'dist/src/cli/embeddings/fastembed-inline/index.js';

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

// Canonical model name emitted into `memory_entries.embedding_model`. The
// semantic-search bin script accepts this plus a short set of legacy aliases
// for entries embedded by earlier moflo versions that still share this
// vector space (all-MiniLM-L6-v2 regardless of runtime).
const EMBEDDING_MODEL = 'fast-all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;
const BATCH_SIZE = 32;

const args = process.argv.slice(2);
const force = args.includes('--force');
const namespaceFilter = args.includes('--namespace')
  ? args[args.indexOf('--namespace') + 1]
  : null;
const verbose = args.includes('--verbose') || args.includes('-v');

function log(msg) {
  console.log(`[build-embeddings] ${msg}`);
}
function debug(msg) {
  if (verbose) console.log(`[build-embeddings]   ${msg}`);
}

// ============================================================================
// Fastembed loader — neural embeddings are required, no fallback
// ============================================================================

let fastembedModel = null;

async function loadModel() {
  if (fastembedModel) return fastembedModel;

  log('Loading fastembed model (fast-all-MiniLM-L6-v2)...');
  const mod = await import(mofloInternalURL(FASTEMBED_INLINE));
  const { FlagEmbedding, EmbeddingModel } = mod;

  fastembedModel = await FlagEmbedding.init({
    model: EmbeddingModel.AllMiniLML6V2,
    showDownloadProgress: true,
  });
  log('fastembed model ready');
  return fastembedModel;
}

async function generateEmbeddings(texts) {
  const model = await loadModel();
  const out = [];
  for await (const batch of model.embed(texts, BATCH_SIZE)) {
    for (const vec of batch) out.push(vec);
  }
  return out;
}

// ============================================================================
// Database operations
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

function getEntriesNeedingEmbeddings(db, namespace, forceAll) {
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
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function updateEmbedding(db, id, embedding) {
  const stmt = db.prepare(
    `UPDATE memory_entries SET embedding = ?, embedding_model = ?, embedding_dimensions = ?, updated_at = ? WHERE id = ?`,
  );
  stmt.run([JSON.stringify(embedding), EMBEDDING_MODEL, EMBEDDING_DIMS, Date.now(), id]);
  stmt.free();
}

function getNamespaceStats(db) {
  const stmt = db.prepare(`
    SELECT
      namespace,
      COUNT(*) as total,
      SUM(CASE WHEN embedding IS NOT NULL AND embedding != '' THEN 1 ELSE 0 END) as vectorized,
      SUM(CASE WHEN embedding IS NULL OR embedding = '' THEN 1 ELSE 0 END) as missing
    FROM memory_entries
    WHERE status = 'active'
    GROUP BY namespace
    ORDER BY namespace
  `);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
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
    byModel,
  };
}

function writeVectorStatsCache(stats, nsCount) {
  try {
    const dbSizeKB = Math.floor(readFileSync(DB_PATH).length / 1024);
    const hnswExists = existsSync(resolve(projectRoot, '.swarm', 'hnsw.index'))
      || existsSync(resolve(projectRoot, '.claude-flow', 'hnsw.index'));
    const cacheData = {
      vectorCount: stats.withEmbeddings,
      dbSizeKB,
      namespaces: nsCount,
      hasHnsw: hnswExists,
      updatedAt: Date.now(),
    };
    for (const cacheDir of [resolve(projectRoot, '.claude-flow'), resolve(projectRoot, '.swarm')]) {
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      writeFileSync(resolve(cacheDir, 'vector-stats.json'), JSON.stringify(cacheData));
    }
  } catch (err) {
    debug(`vector-stats cache write failed (non-fatal): ${err.message}`);
  }
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

  const entries = getEntriesNeedingEmbeddings(db, namespaceFilter, force);
  if (entries.length === 0) {
    log('All entries already have embeddings');
    const stats = getEmbeddingStats(db);
    log(`Total: ${stats.withEmbeddings}/${stats.total} entries embedded`);
    writeVectorStatsCache(stats, getNamespaceStats(db).length);
    db.close();
    return;
  }

  log(`Found ${entries.length} entries to embed`);

  let embedded = 0;
  let failed = 0;
  const startTime = Date.now();

  // Embed in batches to match fastembed's streaming API while keeping progress
  // output tied to the source row order.
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const slice = entries.slice(i, i + BATCH_SIZE);
    const texts = slice.map(e => String(e.content ?? '').substring(0, 1500));

    let vectors;
    try {
      vectors = await generateEmbeddings(texts);
    } catch (err) {
      log(`Batch ${i}-${i + slice.length} failed: ${err.message}`);
      failed += slice.length;
      continue;
    }

    for (let j = 0; j < slice.length; j++) {
      const vec = vectors[j];
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
        failed++;
        continue;
      }
      updateEmbedding(db, slice[j].id, vec);
      embedded++;
    }

    const processed = Math.min(i + slice.length, entries.length);
    const pct = Math.round((processed / entries.length) * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r[build-embeddings] Progress: ${processed}/${entries.length} (${pct}%) - ${elapsed}s elapsed`);
  }
  console.log('');

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  if (embedded > 0) {
    saveDb(db);
    for (const p of [
      resolve(projectRoot, '.swarm/hnsw.index'),
      resolve(projectRoot, '.swarm/hnsw.metadata.json'),
    ]) {
      if (existsSync(p)) {
        unlinkSync(p);
        log(`Deleted stale HNSW index: ${p}`);
      }
    }
  }

  const stats = getEmbeddingStats(db);
  console.log('');
  log('═══════════════════════════════════════════════════════════');
  log('  Embedding Generation Complete');
  log('═══════════════════════════════════════════════════════════');
  log(`  Embedded:     ${embedded} entries`);
  log(`  Failed:       ${failed} entries`);
  log(`  Time:         ${totalTime}s`);
  log(`  Model:        ${EMBEDDING_MODEL}`);
  log(`  Dimensions:   ${EMBEDDING_DIMS}`);
  log('');
  log(`  Total Coverage: ${stats.withEmbeddings}/${stats.total} entries`);
  if (stats.byModel.length > 0) {
    log('  By Model:');
    for (const m of stats.byModel) {
      log(`    - ${m.embedding_model}: ${m.cnt}`);
    }
  }
  log('');

  const nsStats = getNamespaceStats(db);
  if (nsStats.length > 0) {
    log('  Namespace Health:');
    log('  ┌─────────────────┬───────┬────────────┬─────────┐');
    log('  │ Namespace       │ Total │ Vectorized │ Missing │');
    log('  ├─────────────────┼───────┼────────────┼─────────┤');
    let hasWarnings = false;
    for (const ns of nsStats) {
      const name = String(ns.namespace).padEnd(15);
      const total = String(ns.total).padStart(5);
      const vectorized = String(ns.vectorized).padStart(10);
      const missing = String(ns.missing).padStart(7);
      const warn = ns.missing > 0 ? ' ⚠' : '  ';
      log(`  │ ${name} │${total} │${vectorized} │${missing} │${warn}`);
      if (ns.missing > 0) hasWarnings = true;
    }
    log('  └─────────────────┴───────┴────────────┴─────────┘');
    if (hasWarnings) {
      log('');
      log('  ⚠ Some namespaces have rows missing embeddings.');
      log('    Re-run with --force to re-embed everything:');
      log('      node node_modules/moflo/bin/build-embeddings.mjs --force');
    }
  }
  log('═══════════════════════════════════════════════════════════');

  writeVectorStatsCache(stats, nsStats.length);
  db.close();
}

main().catch(err => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
