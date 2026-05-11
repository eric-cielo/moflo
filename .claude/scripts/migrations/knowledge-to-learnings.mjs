/**
 * Migration: copy every row (active + archived) from the deprecated `knowledge`
 * namespace into `learnings`, tagging with `source:user`, `locked`,
 * `migratedFrom:knowledge` so future decay/prune leaves them alone. Archived
 * rows preserve their `status='archived'` on the learnings side.
 *
 * Source `knowledge` rows are preserved here; the follow-on `knowledge-purge`
 * migration hard-deletes them once their counterpart is confirmed.
 *
 * @module bin/migrations/knowledge-to-learnings
 */

import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { memoryDbPath } from '../lib/moflo-paths.mjs';
import { openBackend } from '../lib/get-backend.mjs';
import { MIGRATED_FROM_KNOWLEDGE } from './lib/markers.mjs';

export const name = 'knowledge-to-learnings';

function generateId() {
  return `mem_${Date.now()}_${randomBytes(5).toString('hex')}`;
}

function mergeTags(originalJson) {
  const additions = ['source:user', 'locked', MIGRATED_FROM_KNOWLEDGE];
  let original = [];
  try {
    const parsed = JSON.parse(originalJson || '[]');
    if (Array.isArray(parsed)) original = parsed.map(String);
  } catch {
    // malformed tags — treat as empty
  }
  return JSON.stringify([...new Set([...original, ...additions])]);
}

/**
 * @param {string} projectRoot
 * @returns {Promise<{rowsMigrated:number, rowsSkipped:number}>}
 *   `rowsMigrated` counts both active and archived inserts. `rowsSkipped`
 *   counts (key, status) pairs that already had a learnings counterpart.
 */
export async function run(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { rowsMigrated: 0, rowsSkipped: 0 };

  // Lazy-load via the backend factory — top-level await would pay the engine
  // init cost even on the no-op fast-path where the manifest already records
  // this migration as done.
  const db = await openBackend(projectRoot, { create: false });

  const sourceStmt = db.prepare(
    `SELECT id, key, content, type, metadata, tags, embedding, embedding_dimensions,
            embedding_model, owner_id, created_at, updated_at, expires_at,
            last_accessed_at, access_count, status
     FROM memory_entries
     WHERE namespace = 'knowledge' AND status IN ('active','archived')`,
  );
  const rows = [];
  while (sourceStmt.step()) rows.push(sourceStmt.getAsObject());
  sourceStmt.free();

  if (rows.length === 0) {
    db.close();
    return { rowsMigrated: 0, rowsSkipped: 0 };
  }

  const existingStmt = db.prepare(
    `SELECT key, status FROM memory_entries WHERE namespace = 'learnings' AND status IN ('active','archived')`,
  );
  // key|status pairs — a knowledge row's archived counterpart shouldn't block
  // copying its active version (and vice-versa) so we key by both fields.
  const existingPairs = new Set();
  while (existingStmt.step()) {
    const r = existingStmt.getAsObject();
    existingPairs.add(`${String(r.key)}|${String(r.status)}`);
  }
  existingStmt.free();

  const insertStmt = db.prepare(`
    INSERT INTO memory_entries
      (id, key, namespace, content, type, embedding, embedding_model, embedding_dimensions,
       tags, metadata, owner_id, created_at, updated_at, expires_at,
       last_accessed_at, access_count, status)
    VALUES (?, ?, 'learnings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let migrated = 0;
  let skipped = 0;
  try {
    for (const row of rows) {
      const key = String(row.key);
      const status = String(row.status ?? 'active');
      if (existingPairs.has(`${key}|${status}`)) { skipped++; continue; }

      insertStmt.run([
        generateId(),
        key,
        row.content ?? '',
        row.type ?? null,
        row.embedding ?? null,
        row.embedding_model ?? null,
        row.embedding_dimensions ?? null,
        mergeTags(row.tags ?? '[]'),
        row.metadata ?? '{}',
        row.owner_id ?? null,
        row.created_at ?? Date.now(),
        Date.now(),
        row.expires_at ?? null,
        row.last_accessed_at ?? null,
        row.access_count ?? 0,
        status,
      ]);
      migrated++;
    }
  } finally {
    insertStmt.free();
  }

  if (migrated > 0) db.save();
  db.close();
  return { rowsMigrated: migrated, rowsSkipped: skipped };
}
