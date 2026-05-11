/**
 * Migration: strip the legacy `[Context from previous section:]` /
 * `[Context from next section:]` preamble blocks from every existing chunk
 * (#1053 S5). The chunker no longer writes them — they were a workaround for
 * missing traversal, and once memory_get_neighbors is wired (S2),
 * prevChunk/nextChunk metadata + a real call is the alternative path.
 *
 * For every chunk whose content carries a preamble marker:
 *   1. Strip the preamble block(s) in place
 *   2. NULL the embedding column so build-embeddings regenerates it from the
 *      cleaned content on the next indexer pass
 *
 * Idempotent: chunks already in the new shape (no preamble markers) are
 * untouched.
 *
 * @module bin/migrations/strip-context-preambles
 */

import { existsSync } from 'fs';
import { memoryDbPath } from '../lib/moflo-paths.mjs';
import { openBackend } from '../lib/get-backend.mjs';

export const name = 'strip-context-preambles';
// Run after purge-doc-entries (which itself has order=0 default). Explicit
// ordering keeps this independent of fs sort order.
export const order = 20;

// Validated against real chunks; the back-to-back `---` runs that earlier
// drafts mishandled are absorbed by the trailing `(?:---\n\n)*` / leading
// `(?:\n\n---)+` greediness.
const PREV_PREAMBLE = /\[Context from previous section:\][\s\S]*?\n\n---\n\n(?:---\n\n)*/g;
const NEXT_PREAMBLE = /(?:\n\n---)+\n\n\[Context from next section:\][\s\S]*$/g;

function strip(content) {
  // Reset lastIndex defensively — global regex state can leak across calls
  // when reused on a hot path.
  PREV_PREAMBLE.lastIndex = 0;
  NEXT_PREAMBLE.lastIndex = 0;
  return content.replace(PREV_PREAMBLE, '').replace(NEXT_PREAMBLE, '');
}

/**
 * @param {string} projectRoot
 * @returns {Promise<{stripped:number, untouched:number}>}
 */
export async function run(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { stripped: 0, untouched: 0 };

  const db = await openBackend(projectRoot, { create: false });

  // Only chunks can carry the preamble — the chunker is the only writer of
  // those markers. Filter on key prefix to keep the LIKE selective; manual
  // memory entries containing the literal string are extremely unlikely and
  // the strip is a no-op for them anyway.
  const stmt = db.prepare(
    `SELECT id, content FROM memory_entries WHERE key LIKE 'chunk-%' AND status = 'active'`,
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  if (rows.length === 0) {
    db.close();
    return { stripped: 0, untouched: 0 };
  }

  let stripped = 0;
  let untouched = 0;
  const update = db.prepare(`UPDATE memory_entries SET content = ?, embedding = NULL WHERE id = ?`);
  try {
    for (const row of rows) {
      const original = String(row.content || '');
      // Cheap prefix-check to avoid running the regex on chunks that have no
      // preamble — covers the common idempotent re-run case in O(1).
      if (!original.includes('[Context from previous section:]') && !original.includes('[Context from next section:]')) {
        untouched++;
        continue;
      }
      const cleaned = strip(original);
      if (cleaned === original) {
        untouched++;
        continue;
      }
      update.run([cleaned, row.id]);
      stripped++;
    }
  } finally {
    update.free();
  }

  if (stripped > 0) db.save();
  db.close();
  return { stripped, untouched };
}
