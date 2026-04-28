/**
 * Unit tests for the #729 ephemeral-namespace purge service.
 *
 * Covers:
 *  - Hard-deletes rows from each of the four ephemeral namespaces
 *    (hive-mind, tasklist, epic-state, test-bridge-fix)
 *  - Preserves rows in unrelated namespaces (knowledge, patterns, etc.)
 *  - Idempotent: clean DB returns purged: 0 and does not rewrite the file
 *  - Skips DBs that lack memory_entries
 *  - Returns purged: 0 when the DB does not exist
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { purgeEphemeralNamespaces } from '../../services/ephemeral-namespace-purge.js';
import { EPHEMERAL_NAMESPACES } from '../../memory/bridge-embedder.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';

type SqlJsDb = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
};
type SqlJsStatic = { Database: new (data?: Uint8Array) => SqlJsDb };

let SQL: SqlJsStatic;

beforeAll(async () => {
  const initSqlJs = (await import('sql.js')).default;
  SQL = (await initSqlJs()) as SqlJsStatic;
});

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal — Windows occasionally holds file handles */
    }
  }
});

async function makeTmpDb(setup: (db: SqlJsDb) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-eph-purge-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  const db = new SQL.Database();
  db.run(MEMORY_SCHEMA_V3);
  setup(db);
  const bytes = db.export();
  db.close();
  await writeFile(dbPath, Buffer.from(bytes));
  return dbPath;
}

function countByNamespace(dbBytes: Uint8Array, namespace: string): number {
  const db = new SQL.Database(dbBytes);
  try {
    const stmt = `SELECT COUNT(*) FROM memory_entries WHERE namespace = '${namespace}'`;
    const rows = db.exec(stmt);
    return Number(rows[0]?.values?.[0]?.[0] ?? 0);
  } finally {
    db.close();
  }
}

describe('purgeEphemeralNamespaces (#729)', () => {
  it('returns purged: 0 when the DB file does not exist', async () => {
    const result = await purgeEphemeralNamespaces({
      dbPath: join(tmpdir(), 'moflo-missing-729', 'nope.db'),
    });
    expect(result).toEqual({ purged: 0 });
  });

  it('hard-deletes rows from every ephemeral namespace and preserves others', async () => {
    const dbPath = await makeTmpDb((db) => {
      let n = 0;
      const insert = (id: string, ns: string, content: string) =>
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
          [id, `k-${id}`, ns, content],
        );

      // 2 rows per ephemeral namespace
      for (const ns of EPHEMERAL_NAMESPACES) {
        insert(`${ns}-${++n}`, ns, `ephemeral-${ns}-1`);
        insert(`${ns}-${++n}`, ns, `ephemeral-${ns}-2`);
      }

      // Untouchable: 3 rows in real namespaces with valid content
      insert('keep-1', 'knowledge', 'real user knowledge');
      insert('keep-2', 'patterns', 'a learned pattern');
      insert('keep-3', 'guidance', 'guidance entry');
    });

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result.purged).toBe(EPHEMERAL_NAMESPACES.size * 2);

    const after = await readFile(dbPath);
    for (const ns of EPHEMERAL_NAMESPACES) {
      expect(countByNamespace(after, ns)).toBe(0);
    }
    expect(countByNamespace(after, 'knowledge')).toBe(1);
    expect(countByNamespace(after, 'patterns')).toBe(1);
    expect(countByNamespace(after, 'guidance')).toBe(1);
  });

  it('is idempotent: a clean DB returns purged: 0 without writing', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['live', 'k', 'patterns', 'c'],
      );
    });

    const before = await readFile(dbPath);
    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result).toEqual({ purged: 0 });

    // No write means the file bytes are unchanged.
    const after = await readFile(dbPath);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it('running twice in succession is a no-op on the second pass', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['t1', 'k1', 'tasklist', 'sp-foo'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['t2', 'k2', 'epic-state', 'epic-7'],
      );
    });

    const first = await purgeEphemeralNamespaces({ dbPath });
    expect(first.purged).toBe(2);

    const second = await purgeEphemeralNamespaces({ dbPath });
    expect(second.purged).toBe(0);
  });

  it('skips DBs that lack a memory_entries table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-eph-purge-other-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'something.db');
    const db = new SQL.Database();
    db.run(`CREATE TABLE other_table (id TEXT PRIMARY KEY);`);
    const bytes = db.export();
    db.close();
    await writeFile(dbPath, Buffer.from(bytes));

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result).toEqual({ purged: 0 });
  });
});

describe('EPHEMERAL_NAMESPACES (#729)', () => {
  it('contains exactly the four documented namespaces', () => {
    expect(Array.from(EPHEMERAL_NAMESPACES).sort()).toEqual(
      ['epic-state', 'hive-mind', 'tasklist', 'test-bridge-fix'],
    );
  });
});
