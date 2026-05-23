#!/usr/bin/env node
/**
 * Index installed library docs into moflo memory under the `reference` namespace.
 *
 * Native, version-pinned alternative to a hosted docs MCP (e.g. Context7). For
 * every package the repo DIRECTLY depends on, this reads the docs that already
 * sit in `node_modules` — the entry `.d.ts` type surface and the README — chunks
 * them, and stores them keyed on the INSTALLED version. Retrieval is free: the
 * chunks land in the same HNSW store every other namespace uses, so the agent's
 * mandated `memory_search` first action surfaces them with navigation crumbs.
 *
 * Why this shape (see issue #1184):
 *   - Version-correct by construction — the resolved folder IS the version; we
 *     read `node_modules/<pkg>/package.json.version`, so it works identically
 *     across npm/yarn/pnpm/bun with no lockfile parsing.
 *   - Zero network, fully offline — `fs` reads only.
 *   - Cross-platform — `path.join` only, no shelling out.
 *   - Bounded — DIRECT deps only (not the transitive tree), with per-doc size
 *     and chunk caps so one mega-package can't dominate the index.
 *   - Graceful — a package with no README/types contributes nothing; never an
 *     error. Wrong docs are worse than none.
 *
 * The pure discovery/chunking/entry-shaping logic lives in
 * `./lib/reference-docs.mjs` (unit-tested); this file is the orchestrator that
 * owns the DB write, the incremental-diff gate, and the background embed spawn.
 *
 * Usage:
 *   node node_modules/moflo/bin/index-reference.mjs             # Incremental
 *   node node_modules/moflo/bin/index-reference.mjs --force     # Full reindex
 *   node node_modules/moflo/bin/index-reference.mjs --verbose   # Detailed logging
 *   node node_modules/moflo/bin/index-reference.mjs --stats     # Print stats and exit
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveMofloBin } from './lib/resolve-bin.mjs';
import { memoryDbPath, MOFLO_DIR, findProjectRoot } from './lib/moflo-paths.mjs';
import { openBackend } from './lib/get-backend.mjs';
import { applyIncrementalChunks, computeContentListHash } from './lib/incremental-write.mjs';
import { createProcessManager } from './lib/process-manager.mjs';
import { collectReferenceDocs, buildDocEntries } from './lib/reference-docs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const projectRoot = findProjectRoot();
const NAMESPACE = 'reference';
const DB_PATH = memoryDbPath(projectRoot);
const HASH_CACHE_PATH = resolve(projectRoot, MOFLO_DIR, 'reference-hash.txt');

const args = process.argv.slice(2);
const force = args.includes('--force');
const verbose = args.includes('--verbose') || args.includes('-v');
const statsOnly = args.includes('--stats');

function log(msg) { console.log(`[index-reference] ${msg}`); }
function debug(msg) { if (verbose) console.log(`[index-reference]   ${msg}`); }

// ---------------------------------------------------------------------------
// Database helpers — identical shape to the other indexers (#745 incremental)
// ---------------------------------------------------------------------------

function ensureDbDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function getDb() {
  ensureDbDir();
  const db = await openBackend(projectRoot, { create: true });
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

function countNamespace(db) {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = ?`);
  stmt.bind([NAMESPACE]);
  let count = 0;
  if (stmt.step()) count = stmt.getAsObject().cnt;
  stmt.free();
  return count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  const { packages, docFiles, depCount } = collectReferenceDocs(projectRoot);

  if (depCount === 0) {
    log('No dependencies found in package.json (nothing to ground)');
    return;
  }

  if (statsOnly) {
    const db = await getDb();
    const count = countNamespace(db);
    db.close();
    log(`${packages.length} packages with docs (of ${depCount} deps), ${count} chunks in reference namespace`);
    return;
  }

  if (packages.length === 0) {
    log(`No installed docs found across ${depCount} dependencies`);
    return;
  }

  // Outer gate — content hash over the doc files combined with each resolved
  // name@version (so a version bump with byte-identical docs still re-keys).
  // The version line is folded straight into the digest — no sidecar file — so
  // the gate is deterministic and side-effect-free. Skips the whole
  // extract+write pipeline when nothing changed (#746).
  const versionLine = packages.map((p) => `${p.name}@${p.version}`).join(',');
  const currentHash = createHash('sha256')
    .update(versionLine)
    .update('\n')
    .update(computeContentListHash(docFiles))
    .digest('hex');

  if (!force && existsSync(HASH_CACHE_PATH)) {
    const cached = readFileSync(HASH_CACHE_PATH, 'utf-8').trim();
    if (cached === currentHash) {
      log('No dependency-doc changes detected (use --force to reindex)');
      return;
    }
  }

  // Extract chunks from every resolved package.
  const allEntries = [];
  let packagesIndexed = 0;
  for (const pkg of packages) {
    let pkgEntries = 0;
    if (pkg.readmePath) {
      try {
        const entries = buildDocEntries(pkg, 'readme', readFileSync(pkg.readmePath, 'utf-8'));
        allEntries.push(...entries);
        pkgEntries += entries.length;
      } catch { /* unreadable README — skip */ }
    }
    if (pkg.typesPath) {
      try {
        const entries = buildDocEntries(pkg, 'types', readFileSync(pkg.typesPath, 'utf-8'));
        allEntries.push(...entries);
        pkgEntries += entries.length;
      } catch { /* unreadable .d.ts — skip */ }
    }
    if (pkgEntries > 0) packagesIndexed++;
    debug(`${pkg.name}@${pkg.version}: ${pkgEntries} chunks`);
  }

  log(`Extracted ${allEntries.length} doc chunks from ${packagesIndexed} packages`);

  // Content-aware diff — unchanged rows keep their embeddings; orphaned chunks
  // (including every chunk of an upgraded package's old version) are swept.
  const db = await getDb();
  const counts = applyIncrementalChunks(db, NAMESPACE, allEntries);
  if (counts.inserted + counts.updated + counts.removed > 0) db.save();
  db.close();

  log(
    `Diff: ${counts.inserted} new, ${counts.updated} updated, ` +
    `${counts.unchanged} unchanged, ${counts.removed} removed`,
  );

  writeFileSync(HASH_CACHE_PATH, currentHash, 'utf-8');

  // Embed the new/changed rows in the background, registered with the shared
  // ProcessManager so doctor's zombie scan allowlists it and teardown reaps it.
  // The namespace-derived label dedupes a second index-reference spawn within
  // the lock window; build-embeddings only fills rows whose embedding IS NULL,
  // so index-all's later global pass won't re-embed these.
  try {
    const embeddingScript = resolveMofloBin(
      projectRoot, 'flo-embeddings', 'build-embeddings.mjs', { includeDevFallback: true },
    );
    if (embeddingScript) {
      const pm = createProcessManager(projectRoot);
      const result = pm.spawn('node', [embeddingScript, '--namespace', NAMESPACE], `build-embeddings-${NAMESPACE}`);
      if (result.skipped) {
        debug(`Embedding generation already running (PID: ${result.pid})`);
      } else if (result.pid) {
        debug(`Embedding generation started in background (PID: ${result.pid})`);
      }
    }
  } catch (err) { debug(`embedding spawn skipped: ${err.message}`); }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done in ${elapsed}s — ${allEntries.length} reference chunks written`);
}

main().catch(err => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
