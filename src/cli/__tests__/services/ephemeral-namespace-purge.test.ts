/**
 * Unit tests for the #729 / #968 session-start memory cleanup service.
 *
 * Covers:
 *  - Hard-purges rows from PURGE_ON_SESSION_START_NAMESPACES
 *    (hive-mind, epic-state, test-bridge-fix)
 *  - Preserves tasklist rows up to retention cap (#968 fix)
 *  - Trims tasklist beyond retention cap, keeping the most recent entries
 *  - Preserves rows in unrelated namespaces (knowledge, patterns, etc.)
 *  - Idempotent: clean DB returns { purged: 0, trimmed: 0 } without writing
 *  - Skips DBs that lack memory_entries
 *  - Returns zero counts when the DB does not exist
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { purgeEphemeralNamespaces } from '../../services/ephemeral-namespace-purge.js';
import {
  EPHEMERAL_NAMESPACES,
  PURGE_ON_SESSION_START_NAMESPACES,
  TASKLIST_RETENTION_CAP,
} from '../../memory/bridge-embedder.js';
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

describe('purgeEphemeralNamespaces (#729, #968)', () => {
  it('returns zero counts when the DB file does not exist', async () => {
    const result = await purgeEphemeralNamespaces({
      dbPath: join(tmpdir(), 'moflo-missing-729', 'nope.db'),
    });
    expect(result).toEqual({ purged: 0, trimmed: 0 });
  });

  it('hard-deletes only PURGE_ON_SESSION_START_NAMESPACES and preserves tasklist + others', async () => {
    const dbPath = await makeTmpDb((db) => {
      let n = 0;
      const insert = (id: string, ns: string, content: string) =>
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
          [id, `k-${id}`, ns, content],
        );

      // 2 rows per purge-set namespace
      for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
        insert(`${ns}-${++n}`, ns, `purge-${ns}-1`);
        insert(`${ns}-${++n}`, ns, `purge-${ns}-2`);
      }
      // 3 tasklist rows — well under retention cap, all should survive
      insert('tl-1', 'tasklist', 'flo-100-1700000000000');
      insert('tl-2', 'tasklist', 'flo-101-1700000001000');
      insert('tl-3', 'tasklist', 'flo-102-1700000002000');

      // Untouchable: rows in real user namespaces
      insert('keep-1', 'knowledge', 'real user knowledge');
      insert('keep-2', 'patterns', 'a learned pattern');
      insert('keep-3', 'guidance', 'guidance entry');
    });

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result.purged).toBe(PURGE_ON_SESSION_START_NAMESPACES.size * 2);
    expect(result.trimmed).toBe(0); // 3 < cap, no trim

    const after = await readFile(dbPath);
    for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
      expect(countByNamespace(after, ns)).toBe(0);
    }
    // #968: tasklist must survive
    expect(countByNamespace(after, 'tasklist')).toBe(3);
    expect(countByNamespace(after, 'knowledge')).toBe(1);
    expect(countByNamespace(after, 'patterns')).toBe(1);
    expect(countByNamespace(after, 'guidance')).toBe(1);
  });

  it('trims tasklist beyond retention cap, keeping the most recent rows (#968)', async () => {
    const dbPath = await makeTmpDb((db) => {
      // 7 tasklist rows with monotonic created_at; cap=3 keeps last 3.
      const base = 1_700_000_000_000;
      for (let i = 0; i < 7; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
          [`tl-${i}`, `flo-${i}`, 'tasklist', `record-${i}`, base + i * 1000],
        );
      }
    });

    const result = await purgeEphemeralNamespaces({ dbPath, tasklistRetentionCap: 3 });
    expect(result.purged).toBe(0);
    expect(result.trimmed).toBe(4); // 7 - 3 = 4 oldest deleted

    const after = await readFile(dbPath);
    expect(countByNamespace(after, 'tasklist')).toBe(3);

    // The three most recent (tl-4, tl-5, tl-6) should be the survivors.
    const db = new SQL.Database(after);
    try {
      const rows = db.exec(`SELECT id FROM memory_entries WHERE namespace = 'tasklist' ORDER BY created_at ASC`);
      const ids = (rows[0]?.values ?? []).map(r => r[0]);
      expect(ids).toEqual(['tl-4', 'tl-5', 'tl-6']);
    } finally {
      db.close();
    }
  });

  it('is idempotent: a clean DB returns zero counts without writing', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['live', 'k', 'patterns', 'c'],
      );
    });

    const before = await readFile(dbPath);
    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result).toEqual({ purged: 0, trimmed: 0 });

    // No write means the file bytes are unchanged.
    const after = await readFile(dbPath);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it('running twice in succession is a no-op on the second pass', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['t1', 'k1', 'hive-mind', 'msg-foo'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['t2', 'k2', 'epic-state', 'epic-7'],
      );
    });

    const first = await purgeEphemeralNamespaces({ dbPath });
    expect(first.purged).toBe(2);
    expect(first.trimmed).toBe(0);

    const second = await purgeEphemeralNamespaces({ dbPath });
    expect(second).toEqual({ purged: 0, trimmed: 0 });
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
    expect(result).toEqual({ purged: 0, trimmed: 0 });
  });
});

describe('namespace constants (#729, #968)', () => {
  it('EPHEMERAL_NAMESPACES contains exactly the four embedding-skip namespaces', () => {
    expect(Array.from(EPHEMERAL_NAMESPACES).sort()).toEqual(
      ['epic-state', 'hive-mind', 'tasklist', 'test-bridge-fix'],
    );
  });

  it('PURGE_ON_SESSION_START_NAMESPACES is a strict subset that excludes tasklist (#968)', () => {
    expect(Array.from(PURGE_ON_SESSION_START_NAMESPACES).sort()).toEqual(
      ['epic-state', 'hive-mind', 'test-bridge-fix'],
    );
    expect(PURGE_ON_SESSION_START_NAMESPACES.has('tasklist')).toBe(false);
    for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
      expect(EPHEMERAL_NAMESPACES.has(ns)).toBe(true);
    }
  });

  it('TASKLIST_RETENTION_CAP is set to a sensible default', () => {
    expect(TASKLIST_RETENTION_CAP).toBeGreaterThan(0);
    expect(TASKLIST_RETENTION_CAP).toBeLessThanOrEqual(1000);
  });
});
