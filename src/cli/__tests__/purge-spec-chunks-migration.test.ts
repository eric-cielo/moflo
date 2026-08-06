/**
 * purge-spec-chunks migration: remove SDD spec/plan chunks that earlier
 * versions wrote into the `guidance` namespace, leaving real guidance chunks
 * and every other namespace untouched. Idempotent on re-run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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

function insert(
  db: SqlJsLikeDatabase,
  id: string,
  key: string,
  namespace: string,
  metadata: Record<string, unknown> = {},
) {
  db.run(
    `INSERT INTO memory_entries (id, key, namespace, content, metadata, status) VALUES (?, ?, ?, '', ?, 'active')`,
    [id, key, namespace, JSON.stringify(metadata)],
  );
}

async function runMigration(): Promise<{ purged: number }> {
  const migration = await import('../../../bin/migrations/purge-spec-chunks.mjs');
  return (await migration.run(tmpRoot)) as { purged: number };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'moflo-purge-spec-'));
  mkdirSync(resolve(tmpRoot, '.moflo'), { recursive: true });
  dbPath = resolve(tmpRoot, '.moflo/moflo.db');
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('purge-spec-chunks migration', () => {
  it('removes spec chunks by key prefix and by kind metadata, sparing real guidance', async () => {
    const db = makeDb();
    // Shape 1a: the dedicated `spec` prefix from the retired step 6.
    insert(db, '1', 'chunk-spec-my-feature-spec-0', 'guidance', { kind: 'spec', spec_slug: 'my-feature' });
    insert(db, '2', 'chunk-spec-my-feature-plan-0', 'guidance', { kind: 'spec', spec_slug: 'my-feature' });
    // Shape 1b: kind=spec metadata under some other prefix — matched independently
    // so a partial index that changed the prefix still gets swept.
    insert(db, '3', 'chunk-guidance-stray-spec-0', 'guidance', { kind: 'spec' });
    // Real guidance and skills must survive.
    insert(db, '4', 'chunk-guidance-moflo-sdd-0', 'guidance', { kind: 'guidance' });
    insert(db, '5', 'chunk-skill-fl-0', 'guidance', { kind: 'skill', skill_name: 'fl' });
    // Other namespaces are out of scope entirely.
    insert(db, '6', 'chunk-spec-elsewhere-0', 'learnings', { kind: 'spec' });
    db.close();

    expect((await runMigration()).purged).toBe(3);

    const db2 = openDaemonDatabase(dbPath);
    try {
      const count = (sql: string) => db2.exec(sql)[0]!.values[0]![0];
      expect(count(`SELECT COUNT(*) FROM memory_entries WHERE namespace='guidance' AND key LIKE 'chunk-spec-%'`)).toBe(0);
      expect(count(`SELECT COUNT(*) FROM memory_entries WHERE namespace='guidance' AND metadata LIKE '%"kind":"spec"%'`)).toBe(0);
      expect(count(`SELECT COUNT(*) FROM memory_entries WHERE key='chunk-guidance-moflo-sdd-0'`)).toBe(1);
      expect(count(`SELECT COUNT(*) FROM memory_entries WHERE key='chunk-skill-fl-0'`)).toBe(1);
      // Scoped to `guidance` — a same-shaped row in another namespace is left alone.
      expect(count(`SELECT COUNT(*) FROM memory_entries WHERE namespace='learnings'`)).toBe(1);
    } finally {
      db2.close();
    }
  });

  it('is idempotent — re-runs return purged:0', async () => {
    const db = makeDb();
    insert(db, '1', 'chunk-spec-foo-spec-0', 'guidance', { kind: 'spec' });
    db.close();

    expect((await runMigration()).purged).toBe(1);
    expect((await runMigration()).purged).toBe(0);
  });

  it('no-ops when the database does not exist', async () => {
    rmSync(resolve(tmpRoot, '.moflo'), { recursive: true, force: true });
    expect((await runMigration()).purged).toBe(0);
  });
});
