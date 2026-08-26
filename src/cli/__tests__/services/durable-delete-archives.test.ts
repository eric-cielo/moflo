/**
 * Deleting a durable learning archives it instead of dropping the row (#1463).
 *
 * A hard delete cannot propagate — it is indistinguishable from a row that
 * never existed — so before this the entry came straight back at the next
 * session-start import or worktree seed. Both delete paths are covered: the
 * offline one in `entries-write.deleteEntry` and the daemon-side
 * `bridgeDeleteEntry`, since a rule enforced in only one of them is a rule that
 * holds only until the daemon is running.
 *
 * Non-durable namespaces must still hard-delete: they are never shared, so a
 * tombstone there would be the write-only kind story #728 removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { deleteEntry } from '../../memory/entries-write.js';
import { bridgeDeleteEntry } from '../../memory/bridge-entries.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows file-lock — non-fatal for tests */
    }
  }
});

async function makeDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-del-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'moflo.db');
  await makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const [ns, key] of [
      ['learnings', 'durable-one'],
      ['knowledge', 'durable-two'],
      ['code-map', 'structural'],
    ] as const) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [`id-${ns}-${key}`, key, ns, `content-${key}`, 1_000, 1_000],
      );
    }
  });
  return dbPath;
}

function row(dbPath: string, key: string): { status: string; updated_at: number } | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT status, updated_at FROM memory_entries WHERE key = ?`).get(key) as
      | { status: string; updated_at: number }
      | undefined;
  } finally {
    db.close();
  }
}

describe('deleteEntry (offline path)', () => {
  it('archives a learnings row and stamps the deletion time', async () => {
    const dbPath = await makeDb();
    const before = Date.now();
    const result = await deleteEntry({ key: 'durable-one', namespace: 'learnings', dbPath });

    expect(result.deleted).toBe(true);
    const after = row(dbPath, 'durable-one');
    expect(after?.status).toBe('archived');
    // The stamp is what a later re-creation has to beat, so it must be the
    // deletion time and not the row's original updated_at.
    expect(after!.updated_at).toBeGreaterThanOrEqual(before);
  });

  it('archives a knowledge row too — both durable namespaces are shared', async () => {
    const dbPath = await makeDb();
    await deleteEntry({ key: 'durable-two', namespace: 'knowledge', dbPath });
    expect(row(dbPath, 'durable-two')?.status).toBe('archived');
  });

  it('still hard-deletes a non-durable row', async () => {
    const dbPath = await makeDb();
    const result = await deleteEntry({ key: 'structural', namespace: 'code-map', dbPath });

    expect(result.deleted).toBe(true);
    expect(row(dbPath, 'structural')).toBeUndefined();
  });

  it('reports the entry as gone — every read path filters status', async () => {
    const dbPath = await makeDb();
    await deleteEntry({ key: 'durable-one', namespace: 'learnings', dbPath });

    const db = new DatabaseSync(dbPath);
    try {
      const active = db
        .prepare(`SELECT key FROM memory_entries WHERE status = 'active' ORDER BY key`)
        .all() as Array<{ key: string }>;
      expect(active.map((r) => r.key)).toEqual(['durable-two', 'structural']);
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-deleting an archived row reports not-found', async () => {
    const dbPath = await makeDb();
    await deleteEntry({ key: 'durable-one', namespace: 'learnings', dbPath });
    const second = await deleteEntry({ key: 'durable-one', namespace: 'learnings', dbPath });
    expect(second.deleted).toBe(false);
  });
});

describe('bridgeDeleteEntry (daemon path)', () => {
  it('archives a learnings row rather than dropping it', async () => {
    const dbPath = await makeDb();
    const result = await bridgeDeleteEntry({ key: 'durable-one', namespace: 'learnings', dbPath });

    expect(result?.success).toBe(true);
    expect(result?.deleted).toBe(true);
    expect(row(dbPath, 'durable-one')?.status).toBe('archived');
  });

  it('still hard-deletes a non-durable row', async () => {
    const dbPath = await makeDb();
    const result = await bridgeDeleteEntry({ key: 'structural', namespace: 'code-map', dbPath });

    expect(result?.success).toBe(true);
    expect(row(dbPath, 'structural')).toBeUndefined();
  });
});
