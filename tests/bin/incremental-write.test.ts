/**
 * Regression tests for #745: indexers preserve embeddings on unchanged rows.
 *
 * Pre-#745, every indexer (patterns, code-map, tests) ran `DELETE FROM
 * memory_entries WHERE namespace=?` followed by re-INSERT of every chunk on
 * any file-list-hash mismatch. Because the INSERT statement omits the
 * `embedding` column, every row's embedding was set back to NULL. The
 * downstream `build-embeddings.mjs` step then had to re-vectorise the
 * entire namespace each session — a 60–280s CPU spike pinning every core
 * via fastembed/onnxruntime.
 *
 * The fix is `bin/lib/incremental-write.mjs#applyIncrementalChunks`: load
 * existing rows into a key→content map, skip the write when content is
 * byte-identical, INSERT OR REPLACE on change, and DELETE keys that were
 * stored last run but not produced this run. Embeddings on unchanged rows
 * survive untouched.
 *
 * These tests exercise the helper directly against an in-memory sql.js DB,
 * plus source-level invariants on the three indexers that should no longer
 * call `deleteNamespace(db)` before re-inserting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { applyIncrementalChunks, loadExistingContent } from '../../bin/lib/incremental-write.mjs';

const BIN = resolve(__dirname, '../../bin');

// sql.js exports as a CommonJS factory; importing the default works in Node ESM.
async function makeDb() {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE memory_entries (
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
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      UNIQUE(namespace, key)
    )
  `);
  return db;
}

function getRow(db: any, namespace: string, key: string) {
  const stmt = db.prepare(
    'SELECT key, content, embedding, embedding_model FROM memory_entries WHERE namespace=? AND key=?',
  );
  stmt.bind([namespace, key]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function seed(db: any, namespace: string, rows: Array<{ key: string; content: string; embedding?: string }>) {
  const stmt = db.prepare(
    `INSERT INTO memory_entries
     (id, key, namespace, content, embedding, embedding_model, created_at, updated_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
  );
  const now = Date.now();
  for (const r of rows) {
    stmt.run([
      `id-${r.key}`,
      r.key,
      namespace,
      r.content,
      r.embedding ?? '[0.1,0.2,0.3]',
      'fast-all-MiniLM-L6-v2',
      now,
      now,
    ]);
  }
  stmt.free();
}

describe('applyIncrementalChunks (#745)', () => {
  it('preserves embedding when content is unchanged', async () => {
    const db = await makeDb();
    seed(db, 'patterns', [
      { key: 'pattern:file:a.ts', content: 'C-A', embedding: '[1,1,1]' },
      { key: 'pattern:file:b.ts', content: 'C-B', embedding: '[2,2,2]' },
    ]);

    const counts = applyIncrementalChunks(db, 'patterns', [
      { key: 'pattern:file:a.ts', content: 'C-A' }, // unchanged
      { key: 'pattern:file:b.ts', content: 'C-B' }, // unchanged
    ]);

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 2, removed: 0 });
    expect(getRow(db, 'patterns', 'pattern:file:a.ts')!.embedding).toBe('[1,1,1]');
    expect(getRow(db, 'patterns', 'pattern:file:b.ts')!.embedding).toBe('[2,2,2]');
    db.close();
  });

  it('nulls embedding only on rows whose content changed', async () => {
    const db = await makeDb();
    seed(db, 'code-map', [
      { key: 'file:src/x.ts', content: 'OLD-X', embedding: '[1,1,1]' },
      { key: 'file:src/y.ts', content: 'OLD-Y', embedding: '[2,2,2]' },
    ]);

    const counts = applyIncrementalChunks(db, 'code-map', [
      { key: 'file:src/x.ts', content: 'NEW-X' }, // changed
      { key: 'file:src/y.ts', content: 'OLD-Y' }, // unchanged
    ]);

    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 1, removed: 0 });
    // Changed row — embedding nulled by INSERT OR REPLACE so build-embeddings
    // re-vectorises it.
    const x = getRow(db, 'code-map', 'file:src/x.ts')!;
    expect(x.content).toBe('NEW-X');
    expect(x.embedding).toBeNull();
    // Unchanged row — embedding survives.
    const y = getRow(db, 'code-map', 'file:src/y.ts')!;
    expect(y.embedding).toBe('[2,2,2]');
    db.close();
  });

  it('removes orphan keys present in DB but not in new chunk list', async () => {
    const db = await makeDb();
    seed(db, 'tests', [
      { key: 'test-file:a.test.ts', content: 'TA', embedding: '[1]' },
      { key: 'test-file:b.test.ts', content: 'TB', embedding: '[2]' }, // becomes orphan
      { key: 'test-file:c.test.ts', content: 'TC', embedding: '[3]' },
    ]);

    const counts = applyIncrementalChunks(db, 'tests', [
      { key: 'test-file:a.test.ts', content: 'TA' },
      { key: 'test-file:c.test.ts', content: 'TC' },
    ]);

    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 2, removed: 1 });
    expect(getRow(db, 'tests', 'test-file:b.test.ts')).toBeNull();
    db.close();
  });

  it('inserts new keys with NULL embedding so build-embeddings picks them up', async () => {
    const db = await makeDb();
    seed(db, 'patterns', [
      { key: 'pattern:file:a.ts', content: 'A', embedding: '[1]' },
    ]);

    const counts = applyIncrementalChunks(db, 'patterns', [
      { key: 'pattern:file:a.ts', content: 'A' }, // unchanged
      { key: 'pattern:file:new.ts', content: 'NEW' }, // brand new
    ]);

    expect(counts).toEqual({ inserted: 1, updated: 0, unchanged: 1, removed: 0 });
    const fresh = getRow(db, 'patterns', 'pattern:file:new.ts')!;
    expect(fresh.content).toBe('NEW');
    expect(fresh.embedding).toBeNull();
    expect(getRow(db, 'patterns', 'pattern:file:a.ts')!.embedding).toBe('[1]');
    db.close();
  });

  it('does NOT touch rows in unrelated namespaces', async () => {
    const db = await makeDb();
    seed(db, 'patterns', [{ key: 'pattern:file:a.ts', content: 'A', embedding: '[1]' }]);
    seed(db, 'guidance', [{ key: 'doc-foo', content: 'FOO', embedding: '[9]' }]);

    applyIncrementalChunks(db, 'patterns', []);

    // Whole patterns namespace got swept (every old key is now an orphan), but
    // guidance row is untouched.
    expect(getRow(db, 'patterns', 'pattern:file:a.ts')).toBeNull();
    expect(getRow(db, 'guidance', 'doc-foo')!.embedding).toBe('[9]');
    db.close();
  });

  it('loadExistingContent ignores soft-deleted rows', async () => {
    const db = await makeDb();
    db.run(
      `INSERT INTO memory_entries (id,key,namespace,content,status,created_at,updated_at)
       VALUES ('1','k1','ns','C1','active', 1, 1), ('2','k2','ns','C2','deleted', 1, 1)`,
    );
    const map = loadExistingContent(db, 'ns');
    expect(map.size).toBe(1);
    expect(map.get('k1')).toBe('C1');
    db.close();
  });
});

describe('indexer source no longer wipes namespace before reinsert (#745)', () => {
  for (const file of ['index-patterns.mjs', 'generate-code-map.mjs', 'index-tests.mjs']) {
    it(`${file} uses applyIncrementalChunks instead of deleteNamespace+reinsert`, () => {
      const src = readFileSync(resolve(BIN, file), 'utf-8');
      // Helper imported (DRY across the three indexers)
      expect(src).toMatch(/from\s+['"]\.\/lib\/incremental-write\.mjs['"]/);
      expect(src).toMatch(/applyIncrementalChunks\s*\(/);
      // Old anti-pattern is gone — no `deleteNamespace(db)` call survives, and
      // the helper itself is no longer defined.
      expect(src).not.toMatch(/^\s*deleteNamespace\s*\(\s*db\s*\)/m);
      expect(src).not.toMatch(/^\s*function\s+deleteNamespace\s*\(/m);
      // The local `storeEntry` helper that paired with deleteNamespace is also
      // gone — applyIncrementalChunks owns the writes now.
      expect(src).not.toMatch(/^\s*function\s+storeEntry\s*\(/m);
    });
  }
});
