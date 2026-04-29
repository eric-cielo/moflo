/**
 * Migration: copy every active row from the deprecated `knowledge` namespace
 * into `learnings`, tagging with `source:user`, `locked`, `migratedFrom:knowledge`
 * so future decay/prune leaves them alone.
 *
 * Original `knowledge` rows are preserved (the standing rule against renaming
 * core namespaces forbids deletion); they're just no longer the canonical home.
 *
 * @module bin/migrations/knowledge-to-learnings
 */

import { existsSync, readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { mofloResolveURL } from '../lib/moflo-resolve.mjs';
import { memoryDbPath } from '../lib/moflo-paths.mjs';

const initSqlJs = (await import(mofloResolveURL('sql.js'))).default;

export const name = 'knowledge-to-learnings';

function generateId() {
  return `mem_${Date.now()}_${randomBytes(5).toString('hex')}`;
}

function mergeTags(originalJson) {
  const additions = ['source:user', 'locked', 'migratedFrom:knowledge'];
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
 */
export async function run(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { rowsMigrated: 0, rowsSkipped: 0 };

  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(dbPath));

  const sourceStmt = db.prepare(
    `SELECT id, key, content, type, metadata, tags, embedding, embedding_dimensions,
            embedding_model, owner_id, created_at, updated_at, expires_at,
            last_accessed_at, access_count
     FROM memory_entries
     WHERE namespace = 'knowledge' AND status = 'active'`,
  );
  const rows = [];
  while (sourceStmt.step()) rows.push(sourceStmt.getAsObject());
  sourceStmt.free();

  if (rows.length === 0) {
    db.close();
    return { rowsMigrated: 0, rowsSkipped: 0 };
  }

  const existingStmt = db.prepare(
    `SELECT key FROM memory_entries WHERE namespace = 'learnings' AND status = 'active'`,
  );
  const existingKeys = new Set();
  while (existingStmt.step()) existingKeys.add(String(existingStmt.getAsObject().key));
  existingStmt.free();

  const insertStmt = db.prepare(`
    INSERT INTO memory_entries
      (id, key, namespace, content, type, embedding, embedding_model, embedding_dimensions,
       tags, metadata, owner_id, created_at, updated_at, expires_at,
       last_accessed_at, access_count, status)
    VALUES (?, ?, 'learnings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  let migrated = 0;
  let skipped = 0;
  try {
    for (const row of rows) {
      const key = String(row.key);
      if (existingKeys.has(key)) { skipped++; continue; }

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
      ]);
      migrated++;
    }
  } finally {
    insertStmt.free();
  }

  if (migrated > 0) writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  return { rowsMigrated: migrated, rowsSkipped: skipped };
}
