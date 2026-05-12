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
import {
  applyIncrementalChunks,
  computeContentListHash,
  loadExistingContent,
} from '../../bin/lib/incremental-write.mjs';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BIN = resolve(__dirname, '../../bin');

// node:sqlite (Phase 5 / #1084). The bridge code's sql.js-shape Database API
// is provided by `bin/lib/get-backend.mjs:openBackend`; using `:memory:` keeps
// the test in-process without spilling WAL sidecars onto disk.
async function makeDb() {
  const { openBackend } = await import('../../bin/lib/get-backend.mjs');
  const db = await openBackend(process.cwd(), { dbPath: ':memory:' });
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

describe('computeContentListHash (#746)', () => {
  // Each test gets its own tmpdir so file ops don't leak across cases.
  let dir: string;
  let cleanup: string[] = [];

  function tmpFile(name: string, content: string) {
    const p = join(dir, name);
    writeFileSync(p, content);
    cleanup.push(p);
    return p;
  }

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'moflo-hash-'));
  }

  function teardown() {
    rmSync(dir, { recursive: true, force: true });
    cleanup = [];
  }

  it('same files + same content → same hash', () => {
    setup();
    const a = tmpFile('a.ts', 'export const A = 1;');
    const b = tmpFile('b.ts', 'export const B = 2;');
    expect(computeContentListHash([a, b])).toBe(computeContentListHash([a, b]));
    teardown();
  });

  it('content edit changes the hash', () => {
    setup();
    const a = tmpFile('a.ts', 'export const A = 1;');
    const before = computeContentListHash([a]);
    writeFileSync(a, 'export const A = 2;');
    const after = computeContentListHash([a]);
    expect(after).not.toBe(before);
    teardown();
  });

  it('mtime change without content change does NOT change the hash', () => {
    // This is the whole point: git checkout / npm install / IDE save-on-focus
    // bump mtime without touching content. Pre-#746 patterns indexer used
    // mtime in its hash and re-extracted on every spurious bump.
    setup();
    const a = tmpFile('a.ts', 'export const A = 1;');
    const before = computeContentListHash([a]);
    // Push mtime + atime far into the future.
    const future = new Date(Date.now() + 60_000);
    utimesSync(a, future, future);
    expect(computeContentListHash([a])).toBe(before);
    teardown();
  });

  it('adding a file changes the hash', () => {
    setup();
    const a = tmpFile('a.ts', 'X');
    const before = computeContentListHash([a]);
    const b = tmpFile('b.ts', 'Y');
    expect(computeContentListHash([a, b])).not.toBe(before);
    teardown();
  });

  it('walk order does not affect the hash', () => {
    setup();
    const a = tmpFile('a.ts', 'A');
    const b = tmpFile('b.ts', 'B');
    expect(computeContentListHash([a, b])).toBe(computeContentListHash([b, a]));
    teardown();
  });

  it('missing files still contribute their path to the hash', () => {
    setup();
    const present = tmpFile('present.ts', 'P');
    const ghost = join(dir, 'never-existed.ts');
    const h1 = computeContentListHash([present, ghost]);
    const h2 = computeContentListHash([present]);
    // Ghost path joins the digest even though the file is unreadable, so
    // dropping it must change the hash.
    expect(h1).not.toBe(h2);
    teardown();
  });
});

describe('indexer source uses content-hash gate (#746)', () => {
  for (const file of ['index-patterns.mjs', 'generate-code-map.mjs', 'index-tests.mjs']) {
    it(`${file} imports computeContentListHash and dropped the mtime/size hash`, () => {
      const src = readFileSync(resolve(BIN, file), 'utf-8');
      // Helper imported and called.
      expect(src).toMatch(/computeContentListHash\b/);
      // Old gates are gone.
      expect(src).not.toMatch(/statSync\([^)]*\)\.mtimeMs/);
      expect(src).not.toMatch(/statSync\([^)]*\)\.size/);
      expect(src).not.toMatch(/^\s*function\s+computeFileListHash\s*\(/m);
    });
  }
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
