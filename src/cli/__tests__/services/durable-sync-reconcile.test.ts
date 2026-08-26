/**
 * Tests for reconciling worktree/cross-install durable sync (#1463).
 *
 * This is the third site that was additive on keys, and the one that needs no
 * configuration to be active (`worktree_sharing` defaults on), so it reaches
 * every user with a linked worktree. Corrections and deletions must cross
 * between worktrees, and a learning authored in one and never flushed must
 * survive every sync.
 *
 * Real node:sqlite DBs in tmp dirs; paths via path.join / os.tmpdir (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  reconcileDurableStores,
  seedDurableFromShared,
  flushDurableToShared,
  syncDurableAtSessionStart,
  writeThroughDurable,
  changedRows,
} from '../../services/durable-sync.js';
import { loadMofloConfig, type MofloConfig } from '../../config/moflo-config.js';
import { pruneExpiredArchives } from '../../services/durable-store-io.js';
import { TOMBSTONE_TTL_MS } from '../../services/durable-reconcile.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
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

const savedEnv = process.env.MOFLO_DURABLE_PATH;
beforeEach(() => {
  delete process.env.MOFLO_DURABLE_PATH;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOFLO_DURABLE_PATH;
  else process.env.MOFLO_DURABLE_PATH = savedEnv;
});

/** Ordering-only timestamps, anchored near now so nothing looks expired. */
const T = (offset: number): number => Date.now() - 1_000_000 + offset;

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-durable-rec-'));
  tmpDirs.push(dir);
  return dir;
}

interface Row {
  key: string;
  content?: string;
  updatedAt?: number;
  status?: 'active' | 'archived';
  namespace?: string;
}

function seedDb(dbPath: string, rows: Row[]): Promise<void> {
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      const ns = r.namespace ?? 'learnings';
      const ts = r.updatedAt ?? T(1_000);
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`id-${ns}-${r.key}`, r.key, ns, r.content ?? `content-${r.key}`, ts, ts, r.status ?? 'active'],
      );
    }
  });
}

function activeRows(dbPath: string): Array<{ key: string; content: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`SELECT key, content FROM memory_entries WHERE status = 'active' ORDER BY key`)
      .all() as Array<{ key: string; content: string }>;
  } finally {
    db.close();
  }
}

function allKeys(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT key FROM memory_entries ORDER BY key`).all() as Array<{ key: string }>).map(
      (r) => r.key,
    );
  } finally {
    db.close();
  }
}

describe('reconcileDurableStores (#1463)', () => {
  it('carries a correction into the target', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.db');
    const target = join(root, 'target.db');
    await seedDb(source, [{ key: 'lesson', content: 'corrected', updatedAt: T(3_000) }]);
    await seedDb(target, [{ key: 'lesson', content: 'stale', updatedAt: T(1_000) }]);

    const result = reconcileDurableStores(source, target);
    expect(result.updated).toBe(1);
    expect(activeRows(target)).toEqual([{ key: 'lesson', content: 'corrected' }]);
  });

  it('keeps the target when it is newer — the same pair, reversed', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.db');
    const target = join(root, 'target.db');
    await seedDb(source, [{ key: 'lesson', content: 'stale', updatedAt: T(1_000) }]);
    await seedDb(target, [{ key: 'lesson', content: 'corrected', updatedAt: T(3_000) }]);

    const result = reconcileDurableStores(source, target);
    expect(result.updated).toBe(0);
    expect(result.keptTarget).toBe(1);
    expect(activeRows(target)).toEqual([{ key: 'lesson', content: 'corrected' }]);
  });

  it('carries a purge into the target', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.db');
    const target = join(root, 'target.db');
    await seedDb(source, [{ key: 'purged', content: 'v1', updatedAt: T(3_000), status: 'archived' }]);
    await seedDb(target, [{ key: 'purged', content: 'v1', updatedAt: T(1_000) }]);

    const result = reconcileDurableStores(source, target);
    expect(result.archived).toBe(1);
    expect(activeRows(target)).toEqual([]);
  });

  it('does NOT purge an entry the target re-created after the deletion', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.db');
    const target = join(root, 'target.db');
    await seedDb(source, [{ key: 'lesson', content: 'v1', updatedAt: T(1_000), status: 'archived' }]);
    await seedDb(target, [{ key: 'lesson', content: 'learned again', updatedAt: T(3_000) }]);

    const result = reconcileDurableStores(source, target);
    expect(result.archived).toBe(0);
    expect(activeRows(target)).toEqual([{ key: 'lesson', content: 'learned again' }]);
  });

  it('never touches a row only the target has', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.db');
    const target = join(root, 'target.db');
    await seedDb(source, [{ key: 'shared', content: 'v1', updatedAt: T(1_000) }]);
    await seedDb(target, [{ key: 'target-only', content: 'authored here', updatedAt: T(1_000) }]);

    reconcileDurableStores(source, target);
    expect(activeRows(target)).toEqual([
      { key: 'shared', content: 'v1' },
      { key: 'target-only', content: 'authored here' },
    ]);
  });

  it('is a no-op against a missing source rather than a throw', async () => {
    const root = await makeRoot();
    const target = join(root, 'target.db');
    await seedDb(target, [{ key: 'mine', updatedAt: T(1_000) }]);

    const result = reconcileDurableStores(join(root, 'not-there.db'), target);
    expect(changedRows(result)).toBe(0);
    expect(activeRows(target)).toHaveLength(1);
  });

  it('refuses to reconcile a store with itself', async () => {
    const root = await makeRoot();
    const db = join(root, 'one.db');
    await seedDb(db, [{ key: 'a', updatedAt: T(1_000) }]);

    const result = reconcileDurableStores(db, db);
    expect(changedRows(result)).toBe(0);
    expect(result.sources[0].reason).toBe('self-reference');
  });

  it('ignores non-durable namespaces in both directions', async () => {
    const root = await makeRoot();
    const source = join(root, 'source.db');
    const target = join(root, 'target.db');
    await seedDb(source, [{ key: 'ephemeral', namespace: 'code-map', updatedAt: T(3_000) }]);
    await seedDb(target, [{ key: 'x', updatedAt: T(1_000) }]);

    const result = reconcileDurableStores(source, target);
    expect(result.copied).toBe(0);
    expect(allKeys(target)).toEqual(['x']);
  });
});

describe('a purge survives a full worktree session-start sync', () => {
  // The #1463 symptom in miniature: before this, flush+seed was a union, so an
  // entry purged in this worktree was resurrected by the seed within seconds.
  it('does not come back from the shared store', async () => {
    const root = await makeRoot();
    const shared = join(root, 'shared.db');
    const local = memoryDbPath(root);

    await seedDb(local, [
      { key: 'kept', content: 'v1', updatedAt: T(1_000) },
      { key: 'purged', content: 'v1', updatedAt: T(1_000) },
    ]);
    await flushDurableToShared(root, shared);
    expect(activeRows(shared).map((r) => r.key)).toEqual(['kept', 'purged']);

    // Purge locally, the way `flo memory delete` now does it.
    const db = new DatabaseSync(local);
    db.prepare(`UPDATE memory_entries SET status = 'archived', updated_at = ? WHERE key = 'purged'`).run(T(5_000));
    db.close();

    // Session-start order: flush first, then seed.
    await flushDurableToShared(root, shared);
    await seedDurableFromShared(root, shared);

    expect(activeRows(local).map((r) => r.key)).toEqual(['kept']);
    expect(activeRows(shared).map((r) => r.key)).toEqual(['kept']);
  });
});

describe('pruneExpiredArchives', () => {
  it('drops archives past the retention window and keeps live rows and fresh archives', async () => {
    const root = await makeRoot();
    const dbPath = join(root, 'store.db');
    const now = Date.now();
    await seedDb(dbPath, [
      { key: 'live-and-ancient', content: 'v1', updatedAt: now - TOMBSTONE_TTL_MS - 10_000 },
      { key: 'archived-ancient', content: 'v1', updatedAt: now - TOMBSTONE_TTL_MS - 10_000, status: 'archived' },
      { key: 'archived-fresh', content: 'v1', updatedAt: now - 1_000, status: 'archived' },
    ]);

    const db = openDaemonDatabase(dbPath);
    let removed = 0;
    try {
      removed = pruneExpiredArchives(db, now, TOMBSTONE_TTL_MS);
    } finally {
      db.close();
    }

    expect(removed).toBe(1);
    expect(allKeys(dbPath)).toEqual(['archived-fresh', 'live-and-ancient']);
  });
});

/** Config with an explicit durable_path, built off the real defaults. */
function configWithDurable(root: string, durablePath?: string): MofloConfig {
  const cfg = loadMofloConfig(root);
  cfg.memory.durable_path = durablePath;
  return cfg;
}

describe('archive retention never resurrects a purge', () => {
  // Regression: the prune used to run inside each direction. A worktree dormant
  // past the retention window flushed its stale live row first, the shared
  // tombstone correctly won — and was then pruned as expired in that same
  // flush, before the seed could apply the deletion here. The next session
  // re-inserted the purged entry into every workspace.
  it('applies the deletion before dropping the evidence for it', async () => {
    const root = await makeRoot();
    const shared = join(root, 'shared.db');
    const local = memoryDbPath(root);
    const now = Date.now();

    // This worktree has been dormant far longer than the retention window.
    await seedDb(local, [{ key: 'purged', content: 'v1', updatedAt: now - TOMBSTONE_TTL_MS - 20 * 86_400_000 }]);
    // The shared store's tombstone is itself already expired.
    await seedDb(shared, [
      { key: 'purged', content: 'v1', updatedAt: now - TOMBSTONE_TTL_MS - 86_400_000, status: 'archived' },
    ]);

    await syncDurableAtSessionStart({ projectRoot: root, config: configWithDurable(root, shared) });
    expect(activeRows(local)).toEqual([]);

    // The session after — this is where the resurrection used to happen.
    await syncDurableAtSessionStart({ projectRoot: root, config: configWithDurable(root, shared) });
    expect(activeRows(local)).toEqual([]);
    expect(activeRows(shared)).toEqual([]);
  });

  it('prunes the local store even when sharing is switched off', async () => {
    const root = await makeRoot();
    const local = memoryDbPath(root);
    const now = Date.now();
    await seedDb(local, [
      { key: 'live', content: 'v1', updatedAt: now - 1_000 },
      { key: 'old-archive', content: 'v1', updatedAt: now - TOMBSTONE_TTL_MS - 1_000, status: 'archived' },
    ]);

    const report = await syncDurableAtSessionStart({ projectRoot: root, config: configWithDurable(root, undefined) });
    expect(report.durablePath).toBeNull();
    expect(report.prunedArchives).toBe(1);
    expect(allKeys(local)).toEqual(['live']);
  });
});

describe('writeThroughDurable flushes only the key that changed', () => {
  it('propagates the written key and leaves the rest to session-start', async () => {
    const root = await makeRoot();
    const shared = join(root, 'shared.db');
    await seedDb(memoryDbPath(root), [
      { key: 'just-written', content: 'v1', updatedAt: T(2_000) },
      { key: 'written-earlier', content: 'v1', updatedAt: T(1_000) },
    ]);

    await writeThroughDurable('learnings', {
      projectRoot: root,
      config: configWithDurable(root, shared),
      key: 'just-written',
    });

    expect(activeRows(shared).map((r) => r.key)).toEqual(['just-written']);

    // The full reconciliation at session-start catches everything else up.
    await flushDurableToShared(root, shared);
    expect(activeRows(shared).map((r) => r.key)).toEqual(['just-written', 'written-earlier']);
  });
});
