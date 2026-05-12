/**
 * #1053 S4: purge-doc-entries migration must remove every legacy doc-*
 * row, leaving chunk-* and other namespace rows untouched. Idempotent on
 * re-run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../memory/daemon-backend.js';

let tmpRoot: string;
let dbPath: string;

function makeDb(): SqlJsLikeDatabase {
  const db = openDaemonDatabase(dbPath);
  db.run(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT,
    namespace TEXT,
    content TEXT,
    metadata TEXT,
    status TEXT DEFAULT 'active'
  )`);
  return db;
}

function insert(db: SqlJsLikeDatabase, id: string, key: string, namespace: string) {
  db.run(`INSERT INTO memory_entries (id, key, namespace, content, metadata, status) VALUES (?, ?, ?, '', '{}', 'active')`, [id, key, namespace]);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'moflo-purge-doc-'));
  mkdirSync(resolve(tmpRoot, '.moflo'), { recursive: true });
  dbPath = resolve(tmpRoot, '.moflo/moflo.db');
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('purge-doc-entries migration (#1053 S4)', () => {
  it('removes every doc-* row, leaves chunk-* and other rows alone', async () => {
    const db = makeDb();
    insert(db, '1', 'doc-guidance-foo', 'guidance');
    insert(db, '2', 'doc-guidance-bar', 'guidance');
    insert(db, '3', 'chunk-guidance-foo-0', 'guidance');
    insert(db, '4', 'chunk-guidance-foo-1', 'guidance');
    insert(db, '5', 'pattern-foo', 'patterns');
    insert(db, '6', 'doc-something', 'default');
    db.close();

    const migration = await import('../../../bin/migrations/purge-doc-entries.mjs');
    const result = await migration.run(tmpRoot) as { purged: number };
    expect(result.purged).toBe(3); // doc-guidance-foo, doc-guidance-bar, doc-something

    // Re-open to verify
    const db2 = openDaemonDatabase(dbPath);
    try {
      const docCount = db2.exec(`SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'doc-%'`)[0]!.values[0]![0];
      const chunkCount = db2.exec(`SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'chunk-%'`)[0]!.values[0]![0];
      const patternCount = db2.exec(`SELECT COUNT(*) FROM memory_entries WHERE key = 'pattern-foo'`)[0]!.values[0]![0];
      expect(docCount).toBe(0);
      expect(chunkCount).toBe(2);
      expect(patternCount).toBe(1);
    } finally {
      db2.close();
    }
  });

  it('is idempotent — re-runs return purged:0', async () => {
    const db = makeDb();
    insert(db, '1', 'doc-guidance-foo', 'guidance');
    db.close();

    const migration = await import('../../../bin/migrations/purge-doc-entries.mjs');
    const r1 = await migration.run(tmpRoot) as { purged: number };
    expect(r1.purged).toBe(1);

    const r2 = await migration.run(tmpRoot) as { purged: number };
    expect(r2.purged).toBe(0);
  });

  it('returns purged:0 when no DB file exists', async () => {
    if (existsSync(dbPath)) rmSync(dbPath);
    const migration = await import('../../../bin/migrations/purge-doc-entries.mjs');
    const result = await migration.run(tmpRoot) as { purged: number };
    expect(result.purged).toBe(0);
  });
});
