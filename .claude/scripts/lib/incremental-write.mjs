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
 */
import { randomBytes } from 'crypto';

function generateId() {
  return `mem_${Date.now()}_${randomBytes(5).toString('hex')}`;
}

/**
 * Load `key → content` for every active row in the namespace.
 * @param {object} db - sql.js Database
 * @param {string} namespace
 * @returns {Map<string,string>}
 */
export function loadExistingContent(db, namespace) {
  const stmt = db.prepare(
    `SELECT key, content FROM memory_entries WHERE namespace = ? AND status = 'active'`,
  );
  stmt.bind([namespace]);
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
 * @returns {{inserted:number, updated:number, unchanged:number, removed:number}}
 */
export function applyIncrementalChunks(db, namespace, chunks, opts = {}) {
  const serialize = opts.serialize !== false;
  const existing = loadExistingContent(db, namespace);
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
