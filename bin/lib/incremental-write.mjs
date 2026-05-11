/**
 * Content-aware incremental writes for indexer namespaces.
 *
 * Replaces the previous pattern (`DELETE FROM ... WHERE namespace=?` followed
 * by re-INSERT of every chunk) which nulled the `embedding` column on every
 * untouched row and forced build-embeddings to re-vectorise the whole
 * namespace each session — see #745.
 *
 * Strategy per indexer run:
 *   1. Load every existing (key, content) for the namespace.
 *   2. For each freshly-generated chunk:
 *        - identical content already stored → SKIP (preserves embedding).
 *        - new key OR content differs       → INSERT OR REPLACE (embedding
 *                                              column resets to NULL on
 *                                              purpose so build-embeddings
 *                                              regenerates only this row).
 *   3. Delete keys that were stored last run but not produced this run
 *      (orphans).
 *
 * The shape mirrors the existing `storeEntry` signature already used by every
 * indexer — `metadata` and `tags` are stored as JSON strings. Callers that
 * passed in objects/arrays continue to do so via the optional `serialize`
 * flag; the helper handles the JSON.stringify call.
 *
 * Also exports `computeContentListHash` — the file-list early-exit gate used
 * by every indexer. Content-based (not mtime/size-based) so spurious mtime
 * bumps from git checkout, npm install, IDE save-on-focus, lint --fix etc.
 * no longer trigger a full re-extract. See #746.
 */
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';

function generateId() {
  return `mem_${Date.now()}_${randomBytes(5).toString('hex')}`;
}

/**
 * SHA-256 over every file's path and content. Used as the indexer's outer
 * gate: matches stored hash → no source file actually changed → skip the
 * whole extract+write pipeline.
 *
 * Reading every source file on a typical repo is ~50-200ms on SSD (and the
 * OS file cache makes the second read essentially free), which is the
 * tradeoff for byte-accurate change detection. mtime-based gates fire on
 * every `git checkout` / `npm install` / IDE save-on-focus and force a full
 * re-extract; size-only gates miss any same-size content edit. See #746.
 *
 * @param {string[]} files - absolute paths
 * @returns {string} hex sha256
 */
export function computeContentListHash(files) {
  const hasher = createHash('sha256');
  // Sort so directory walk order doesn't perturb the hash.
  const sorted = [...files].sort();
  for (const f of sorted) {
    hasher.update(f);
    hasher.update('\0');
    try {
      hasher.update(readFileSync(f));
    } catch {
      // Missing file → still hash the path so add/remove flips the hash.
    }
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

/**
 * Load `key → content` for every active row in the namespace, optionally
 * scoped to keys starting with `keyPrefix` (one doc's chunks at a time —
 * lets per-file indexers like `index-guidance.mjs` content-diff without
 * loading every chunk across every file).
 *
 * @param {object} db - sql.js Database
 * @param {string} namespace
 * @param {string} [keyPrefix] — when set, restricts the scan to `key LIKE '<prefix>%'`.
 *   The same prefix scopes the orphan sweep in {@link applyIncrementalChunks}.
 * @returns {Map<string,string>}
 */
export function loadExistingContent(db, namespace, keyPrefix) {
  const stmt = keyPrefix
    ? db.prepare(
        `SELECT key, content FROM memory_entries WHERE namespace = ? AND key LIKE ? AND status = 'active'`,
      )
    : db.prepare(
        `SELECT key, content FROM memory_entries WHERE namespace = ? AND status = 'active'`,
      );
  if (keyPrefix) {
    stmt.bind([namespace, `${keyPrefix}%`]);
  } else {
    stmt.bind([namespace]);
  }
  const map = new Map();
  while (stmt.step()) {
    const row = stmt.getAsObject();
    map.set(String(row.key), String(row.content ?? ''));
  }
  stmt.free();
  return map;
}

/**
 * Apply an indexer's freshly-built chunk list to the DB without re-embedding
 * unchanged rows. Returns counters so the caller can log a meaningful summary.
 *
 * @param {object} db
 * @param {string} namespace
 * @param {Array<{key:string,content:string,metadata?:any,tags?:any}>} chunks
 * @param {object} [opts]
 * @param {boolean} [opts.serialize=true] - JSON.stringify metadata/tags before
 *   writing. Set false when callers already pass strings.
 * @param {string} [opts.keyPrefix] — when set, the existing-content load AND
 *   the orphan sweep are restricted to keys matching `<prefix>%`. Use this
 *   when processing a single file's chunks at a time (e.g. index-guidance.mjs
 *   iterates files independently) — without it the sweep would delete every
 *   chunk from every OTHER file as an orphan on each call.
 * @returns {{inserted:number, updated:number, unchanged:number, removed:number}}
 */
export function applyIncrementalChunks(db, namespace, chunks, opts = {}) {
  const serialize = opts.serialize !== false;
  const keyPrefix = opts.keyPrefix;
  const existing = loadExistingContent(db, namespace, keyPrefix);
  const newKeys = new Set();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO memory_entries
      (id, key, namespace, content, metadata, tags, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  try {
    for (const chunk of chunks) {
      const key = String(chunk.key);
      newKeys.add(key);
      const content = String(chunk.content ?? '');
      const prior = existing.get(key);

      if (prior !== undefined && prior === content) {
        // Identical content already stored — skip the write so the embedding
        // column survives. This is the entire point of the helper.
        unchanged++;
        continue;
      }

      const now = Date.now();
      const id = generateId();
      const metaStr = serialize
        ? JSON.stringify(chunk.metadata ?? {})
        : (chunk.metadata ?? '{}');
      const tagsStr = serialize
        ? JSON.stringify(chunk.tags ?? [])
        : (chunk.tags ?? '[]');

      insertStmt.run([id, key, namespace, content, metaStr, tagsStr, now, now]);

      if (prior === undefined) inserted++;
      else updated++;
    }
  } finally {
    insertStmt.free();
  }

  // Orphan sweep — rows that were present last run but not produced this run.
  // Inline-binding a NOT IN(...) list keeps this a single round-trip even at
  // four-figure cardinalities (sql.js param limit is 999, so chunk if needed).
  let removed = 0;
  if (existing.size > 0) {
    const orphans = [];
    for (const oldKey of existing.keys()) {
      if (!newKeys.has(oldKey)) orphans.push(oldKey);
    }
    if (orphans.length > 0) {
      const delStmt = db.prepare(
        `DELETE FROM memory_entries WHERE namespace = ? AND key = ?`,
      );
      try {
        for (const key of orphans) {
          delStmt.run([namespace, key]);
          removed++;
        }
      } finally {
        delStmt.free();
      }
    }
  }

  return { inserted, updated, unchanged, removed };
}
