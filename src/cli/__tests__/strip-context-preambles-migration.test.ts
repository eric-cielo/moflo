/**
 * #1053 S5: strip-context-preambles migration must remove every legacy
 * `[Context from previous/next section:]` block from existing chunks and
 * NULL their embeddings so build-embeddings regenerates them. Idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';

let tmpRoot: string;
let dbPath: string;

async function makeDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT,
    namespace TEXT,
    content TEXT,
    embedding TEXT,
    metadata TEXT,
    status TEXT DEFAULT 'active'
  )`);
  return { SQL, db };
}

function insertChunk(db: any, id: string, key: string, content: string, embedding: string | null = '[0.1,0.2]') {
  db.run(
    `INSERT INTO memory_entries (id, key, namespace, content, embedding, metadata, status) VALUES (?, ?, 'guidance', ?, ?, '{}', 'active')`,
    [id, key, content, embedding],
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'moflo-strip-preamble-'));
  mkdirSync(resolve(tmpRoot, '.moflo'), { recursive: true });
  dbPath = resolve(tmpRoot, '.moflo/moflo.db');
});
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

const PRE = '# Section\n\n[Context from previous section:]\nold prior text\n\n---\n\n';
const POST = '\n\n---\n\n[Context from next section:]\nold next text';
const BODY = 'real chunk content goes here';

describe('strip-context-preambles migration (#1053 S5)', () => {
  it('strips both preambles, NULLs embedding, leaves clean chunks alone', async () => {
    const { db } = await makeDb();
    insertChunk(db, '1', 'chunk-guidance-foo-0', PRE + BODY + POST);
    insertChunk(db, '2', 'chunk-guidance-foo-1', PRE + BODY);                 // only prev preamble
    insertChunk(db, '3', 'chunk-guidance-foo-2', BODY + POST);                // only next preamble
    insertChunk(db, '4', 'chunk-guidance-foo-3', '# Clean\n\n' + BODY);       // no preamble — untouched
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    const migration = await import('../../../bin/migrations/strip-context-preambles.mjs');
    const result = await migration.run(tmpRoot) as { stripped: number; untouched: number };
    expect(result.stripped).toBe(3);
    expect(result.untouched).toBe(1);

    const SQL = await initSqlJs();
    const db2 = new SQL.Database(readFileSync(dbPath));
    const rows = db2.exec(`SELECT key, content, embedding FROM memory_entries ORDER BY key`)[0]!.values;
    for (const [key, content, embedding] of rows) {
      expect(String(content)).not.toContain('[Context from previous section:]');
      expect(String(content)).not.toContain('[Context from next section:]');
      if (key === 'chunk-guidance-foo-3') {
        // Untouched: embedding preserved
        expect(embedding).not.toBeNull();
      } else {
        // Stripped: embedding nulled so build-embeddings regenerates
        expect(embedding).toBeNull();
      }
    }
    db2.close();
  });

  it('is idempotent — re-runs return stripped:0', async () => {
    const { db } = await makeDb();
    insertChunk(db, '1', 'chunk-guidance-foo-0', PRE + BODY + POST);
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    const migration = await import('../../../bin/migrations/strip-context-preambles.mjs');
    const r1 = await migration.run(tmpRoot) as { stripped: number };
    expect(r1.stripped).toBe(1);

    const r2 = await migration.run(tmpRoot) as { stripped: number; untouched: number };
    expect(r2.stripped).toBe(0);
    expect(r2.untouched).toBe(1);
  });

  it('handles back-to-back --- separators in real-chunk shape', async () => {
    // Real-corpus shape that the user previously caught broke an earlier draft.
    const tricky = '# T\n\n[Context from previous section:]\nfoo\n\n---\n\n---\n\nbody\n\n---\n\n[Context from next section:]\ntail';
    const { db } = await makeDb();
    insertChunk(db, '1', 'chunk-guidance-tricky-0', tricky);
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    const migration = await import('../../../bin/migrations/strip-context-preambles.mjs');
    const r = await migration.run(tmpRoot) as { stripped: number };
    expect(r.stripped).toBe(1);

    const SQL = await initSqlJs();
    const db2 = new SQL.Database(readFileSync(dbPath));
    const content = String(db2.exec(`SELECT content FROM memory_entries WHERE id='1'`)[0]!.values[0]![0]);
    expect(content).not.toContain('[Context from');
    expect(content).not.toContain('---'); // both runs of separators absorbed
    expect(content).toContain('body');
    db2.close();
  });
});
