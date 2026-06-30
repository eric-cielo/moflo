/**
 * Tests for whole-DB snapshot backup/restore (#1244, epic #1231).
 *
 * Covers:
 *   - localDbHasContent: false for missing/empty DB, true once rows exist.
 *   - backupSnapshot: produces a standalone single-file snapshot (no sidecars),
 *     throws on a missing source / self-reference.
 *   - restoreSnapshot: seeds an empty workspace (structural + durable rows
 *     present afterwards), no-clobbers a populated DB unless force, rejects an
 *     invalid/missing snapshot, purges ephemeral namespaces from the restored
 *     copy.
 *   - resolveHydratePath / hydrateAtSessionStart: env > config precedence,
 *     no-op when unconfigured or the local DB already has content.
 *
 * Uses real node:sqlite DBs in tmp dirs — backup/restore is pure file IO with
 * no daemon. All paths go through path.join / os.tmpdir (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  localDbHasContent,
  backupSnapshot,
  restoreSnapshot,
  resolveHydratePath,
  hydrateAtSessionStart,
  RESTORE_SKIP_REASONS,
  resolveSnapshotToPath,
  isLinkedWorktree,
  autoSnapshotAtSessionStart,
  SNAPSHOT_SKIP_REASONS,
} from '../../services/snapshot-restore.js';
import { loadMofloConfig, type MofloConfig } from '../../config/moflo-config.js';
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

const savedEnv = process.env.MOFLO_HYDRATE_FROM;
const savedSnapshotEnv = process.env.MOFLO_SNAPSHOT_TO;
beforeEach(() => {
  delete process.env.MOFLO_HYDRATE_FROM;
  delete process.env.MOFLO_SNAPSHOT_TO;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOFLO_HYDRATE_FROM;
  else process.env.MOFLO_HYDRATE_FROM = savedEnv;
  if (savedSnapshotEnv === undefined) delete process.env.MOFLO_SNAPSHOT_TO;
  else process.env.MOFLO_SNAPSHOT_TO = savedSnapshotEnv;
});

async function makeRoot(prefix = 'moflo-snapshot-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// loadMofloConfig returns a shared/cached config object — mutating `cfg.memory`
// in place would pollute every later loadMofloConfig() in the suite. Clone the
// memory sub-object so each case is hermetic.
function configWithHydrate(root: string, hydrateFrom?: string): MofloConfig {
  const cfg = loadMofloConfig(root);
  return { ...cfg, memory: { ...cfg.memory, hydrate_from: hydrateFrom } };
}

function configWithSnapshotTo(root: string, snapshotTo?: string): MofloConfig {
  const cfg = loadMofloConfig(root);
  return { ...cfg, memory: { ...cfg.memory, snapshot_to: snapshotTo } };
}

/** Force `path`'s mtime to `whenMs` so staleness compares are deterministic
 * (avoids filesystem mtime-granularity flakiness). */
function setMtime(path: string, whenMs: number): void {
  const secs = whenMs / 1000;
  utimesSync(path, secs, secs);
}

/** Seed a V3 memory DB at `dbPath` with (namespace, key) rows. */
function makeDbWith(
  dbPath: string,
  rows: Array<{ key: string; namespace: string; content?: string }>,
): Promise<void> {
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        [`id-${r.namespace}-${r.key}`, r.key, r.namespace, r.content ?? `content-${r.key}`],
      );
    }
  });
}

/** Count rows in a DB by namespace (or all when omitted). */
function rowCount(dbPath: string, namespace?: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const sql = namespace
      ? `SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = ?`
      : `SELECT COUNT(*) AS n FROM memory_entries`;
    const stmt = db.prepare(sql);
    const row = (namespace ? stmt.get(namespace) : stmt.get()) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe('localDbHasContent', () => {
  it('is false for a missing DB', async () => {
    const root = await makeRoot();
    expect(localDbHasContent(root)).toBe(false);
  });

  it('is false for an empty (zero-row) DB', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), []);
    expect(localDbHasContent(root)).toBe(false);
  });

  it('is true once a row exists', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'k', namespace: 'learnings' }]);
    expect(localDbHasContent(root)).toBe(true);
  });
});

describe('backupSnapshot', () => {
  it('writes a standalone single-file snapshot with no sidecars', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [
      { key: 'a', namespace: 'learnings' },
      { key: 'b', namespace: 'code-map' },
    ]);
    const snap = join(root, 'snap.db');
    const result = backupSnapshot({ projectRoot: root, toPath: snap });

    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(snap)).toBe(true);
    expect(existsSync(`${snap}-wal`)).toBe(false);
    expect(existsSync(`${snap}-shm`)).toBe(false);
    // Snapshot is a valid DB carrying BOTH structural and durable rows.
    expect(rowCount(snap)).toBe(2);
  });

  it('produces a consistent snapshot while the source DB holds an open WAL', async () => {
    const root = await makeRoot();
    const dbPath = memoryDbPath(root);
    await makeDbWith(dbPath, [{ key: 'a', namespace: 'learnings' }]);
    // Hold an open WAL connection on the source during the backup — VACUUM INTO
    // must still capture all committed rows into a standalone file.
    const live = new DatabaseSync(dbPath);
    live.exec('PRAGMA journal_mode=WAL');
    live.exec(
      `INSERT INTO memory_entries (id, key, namespace, content) VALUES ('id2', 'b', 'code-map', 'c')`,
    );
    try {
      const snap = join(root, 'snap.db');
      const result = backupSnapshot({ projectRoot: root, toPath: snap });
      expect(result.bytes).toBeGreaterThan(0);
      expect(existsSync(`${snap}-wal`)).toBe(false);
      expect(rowCount(snap)).toBe(2);
    } finally {
      live.close();
    }
  });

  it('throws when there is no local DB to back up', async () => {
    const root = await makeRoot();
    expect(() => backupSnapshot({ projectRoot: root, toPath: join(root, 'snap.db') })).toThrow(
      /nothing to back up/i,
    );
  });

  it('throws when --to aliases the local DB', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'a', namespace: 'learnings' }]);
    expect(() => backupSnapshot({ projectRoot: root, toPath: memoryDbPath(root) })).toThrow(
      /local memory DB itself/i,
    );
  });
});

describe('restoreSnapshot', () => {
  it('seeds an empty workspace with the full DB (structural + durable)', async () => {
    const src = await makeRoot('moflo-snap-src-');
    await makeDbWith(memoryDbPath(src), [
      { key: 'a', namespace: 'learnings' },
      { key: 'b', namespace: 'code-map' },
      { key: 'c', namespace: 'guidance' },
    ]);
    const snap = join(src, 'snap.db');
    backupSnapshot({ projectRoot: src, toPath: snap });

    const dest = await makeRoot('moflo-snap-dest-');
    const result = await restoreSnapshot({ projectRoot: dest, fromPath: snap });

    expect(result.restored).toBe(true);
    expect(rowCount(memoryDbPath(dest))).toBe(3);
    expect(rowCount(memoryDbPath(dest), 'code-map')).toBe(1);
    expect(rowCount(memoryDbPath(dest), 'learnings')).toBe(1);
  });

  it('does not clobber a populated workspace (no force)', async () => {
    const src = await makeRoot('moflo-snap-src-');
    await makeDbWith(memoryDbPath(src), [{ key: 'fromSnap', namespace: 'learnings' }]);
    const snap = join(src, 'snap.db');
    backupSnapshot({ projectRoot: src, toPath: snap });

    const dest = await makeRoot('moflo-snap-dest-');
    await makeDbWith(memoryDbPath(dest), [{ key: 'local', namespace: 'learnings' }]);

    const result = await restoreSnapshot({ projectRoot: dest, fromPath: snap });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe(RESTORE_SKIP_REASONS.LOCAL_NOT_EMPTY);
    // Local content is untouched.
    expect(rowCount(memoryDbPath(dest), 'learnings')).toBe(1);
  });

  it('overwrites a populated workspace when force is set', async () => {
    const src = await makeRoot('moflo-snap-src-');
    await makeDbWith(memoryDbPath(src), [
      { key: 's1', namespace: 'learnings' },
      { key: 's2', namespace: 'learnings' },
    ]);
    const snap = join(src, 'snap.db');
    backupSnapshot({ projectRoot: src, toPath: snap });

    const dest = await makeRoot('moflo-snap-dest-');
    await makeDbWith(memoryDbPath(dest), [{ key: 'local', namespace: 'learnings' }]);

    const result = await restoreSnapshot({ projectRoot: dest, fromPath: snap, force: true });
    expect(result.restored).toBe(true);
    expect(rowCount(memoryDbPath(dest), 'learnings')).toBe(2);
  });

  it('purges ephemeral namespaces from the restored copy', async () => {
    const src = await makeRoot('moflo-snap-src-');
    await makeDbWith(memoryDbPath(src), [
      { key: 'keep', namespace: 'learnings' },
      { key: 'gone', namespace: 'hive-mind' },
    ]);
    const snap = join(src, 'snap.db');
    backupSnapshot({ projectRoot: src, toPath: snap });

    const dest = await makeRoot('moflo-snap-dest-');
    const result = await restoreSnapshot({ projectRoot: dest, fromPath: snap });

    expect(result.restored).toBe(true);
    expect(rowCount(memoryDbPath(dest), 'learnings')).toBe(1);
    expect(rowCount(memoryDbPath(dest), 'hive-mind')).toBe(0);
  });

  it('rejects a missing snapshot', async () => {
    const dest = await makeRoot();
    const result = await restoreSnapshot({ projectRoot: dest, fromPath: join(dest, 'nope.db') });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe(RESTORE_SKIP_REASONS.SNAPSHOT_MISSING);
  });

  it('rejects a non-moflo file (no memory_entries table)', async () => {
    const dest = await makeRoot();
    const bogus = join(dest, 'bogus.db');
    const db = new DatabaseSync(bogus);
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    db.close();
    const result = await restoreSnapshot({ projectRoot: dest, fromPath: bogus });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe(RESTORE_SKIP_REASONS.INVALID_SNAPSHOT);
  });
});

describe('resolveHydratePath / hydrateAtSessionStart', () => {
  it('is off by default', async () => {
    const root = await makeRoot();
    expect(resolveHydratePath(root, configWithHydrate(root, undefined))).toBeNull();
  });

  it('env overrides config', async () => {
    const root = await makeRoot();
    process.env.MOFLO_HYDRATE_FROM = join(root, 'env-snap.db');
    const resolved = resolveHydratePath(root, configWithHydrate(root, join(root, 'cfg-snap.db')));
    expect(resolved).toBe(join(root, 'env-snap.db'));
  });

  it('resolves a relative config path against the project root', async () => {
    const root = await makeRoot();
    const resolved = resolveHydratePath(root, configWithHydrate(root, 'snaps/local.db'));
    expect(resolved).toBe(join(root, 'snaps', 'local.db'));
  });

  it('no-op when unconfigured', async () => {
    const root = await makeRoot();
    const result = await hydrateAtSessionStart({
      projectRoot: root,
      config: configWithHydrate(root, undefined),
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe(RESTORE_SKIP_REASONS.NOT_CONFIGURED);
  });

  it('hydrates an empty workspace from the configured snapshot', async () => {
    const src = await makeRoot('moflo-snap-src-');
    await makeDbWith(memoryDbPath(src), [{ key: 'a', namespace: 'learnings' }]);
    const snap = join(src, 'snap.db');
    backupSnapshot({ projectRoot: src, toPath: snap });

    const dest = await makeRoot('moflo-snap-dest-');
    const result = await hydrateAtSessionStart({
      projectRoot: dest,
      config: configWithHydrate(dest, snap),
    });
    expect(result.restored).toBe(true);
    expect(rowCount(memoryDbPath(dest), 'learnings')).toBe(1);
  });

  it('no-op when the local DB already has content', async () => {
    const src = await makeRoot('moflo-snap-src-');
    await makeDbWith(memoryDbPath(src), [{ key: 'a', namespace: 'learnings' }]);
    const snap = join(src, 'snap.db');
    backupSnapshot({ projectRoot: src, toPath: snap });

    const dest = await makeRoot('moflo-snap-dest-');
    await makeDbWith(memoryDbPath(dest), [{ key: 'local', namespace: 'learnings' }]);
    const result = await hydrateAtSessionStart({
      projectRoot: dest,
      config: configWithHydrate(dest, snap),
    });
    expect(result.restored).toBe(false);
    expect(result.reason).toBe(RESTORE_SKIP_REASONS.LOCAL_NOT_EMPTY);
  });
});

describe('resolveSnapshotToPath', () => {
  it('returns null when neither env nor config is set', async () => {
    const root = await makeRoot();
    expect(resolveSnapshotToPath(root, configWithSnapshotTo(root, undefined))).toBeNull();
  });

  it('resolves a relative config value against the project root', async () => {
    const root = await makeRoot();
    expect(resolveSnapshotToPath(root, configWithSnapshotTo(root, 'seeds/snap.db'))).toBe(
      join(root, 'seeds', 'snap.db'),
    );
  });

  it('prefers the MOFLO_SNAPSHOT_TO env over the config value', async () => {
    const root = await makeRoot();
    const envPath = join(root, 'from-env.db');
    process.env.MOFLO_SNAPSHOT_TO = envPath;
    expect(resolveSnapshotToPath(root, configWithSnapshotTo(root, 'from-config.db'))).toBe(envPath);
  });
});

describe('isLinkedWorktree', () => {
  it('is false for a primary checkout (.git is a directory)', async () => {
    const root = await makeRoot();
    mkdirSync(join(root, '.git'));
    expect(isLinkedWorktree(root)).toBe(false);
  });

  it('is false when there is no .git at all', async () => {
    const root = await makeRoot();
    expect(isLinkedWorktree(root)).toBe(false);
  });

  it('is true for a linked worktree (.git file → gitdir under worktrees/)', async () => {
    const root = await makeRoot();
    writeFileSync(join(root, '.git'), 'gitdir: /repo/.git/worktrees/feature-x\n');
    expect(isLinkedWorktree(root)).toBe(true);
  });

  it('is false for a submodule (.git file → gitdir under modules/)', async () => {
    const root = await makeRoot();
    writeFileSync(join(root, '.git'), 'gitdir: /repo/.git/modules/sub\n');
    expect(isLinkedWorktree(root)).toBe(false);
  });
});

describe('autoSnapshotAtSessionStart', () => {
  it('is a no-op when snapshot_to is not configured', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'a', namespace: 'learnings' }]);
    const result = await autoSnapshotAtSessionStart({
      projectRoot: root,
      config: configWithSnapshotTo(root, undefined),
    });
    expect(result.snapshotted).toBe(false);
    expect(result.reason).toBe(SNAPSHOT_SKIP_REASONS.NOT_CONFIGURED);
  });

  it('produces a faithful snapshot from the primary checkout', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [
      { key: 'a', namespace: 'learnings' },
      { key: 'b', namespace: 'code-map' },
      { key: 'c', namespace: 'guidance' },
    ]);
    const snap = join(root, 'seed.db');
    const result = await autoSnapshotAtSessionStart({
      projectRoot: root,
      config: configWithSnapshotTo(root, snap),
    });
    expect(result.snapshotted).toBe(true);
    expect(result.target).toBe(snap);
    expect(existsSync(snap)).toBe(true);
    expect(rowCount(snap)).toBe(3);
    // Standalone single file — no sidecars (Rule #1 / hydrate reads it directly).
    expect(existsSync(`${snap}-wal`)).toBe(false);
  });

  it('never produces from a linked worktree (Conductor workspace)', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'a', namespace: 'learnings' }]);
    writeFileSync(join(root, '.git'), 'gitdir: /repo/.git/worktrees/wt-1\n');
    const snap = join(root, 'seed.db');
    const result = await autoSnapshotAtSessionStart({
      projectRoot: root,
      config: configWithSnapshotTo(root, snap),
    });
    expect(result.snapshotted).toBe(false);
    expect(result.reason).toBe(SNAPSHOT_SKIP_REASONS.LINKED_WORKTREE);
    expect(existsSync(snap)).toBe(false);
  });

  it('skips when there is no local DB to snapshot', async () => {
    const root = await makeRoot();
    const result = await autoSnapshotAtSessionStart({
      projectRoot: root,
      config: configWithSnapshotTo(root, join(root, 'seed.db')),
    });
    expect(result.snapshotted).toBe(false);
    expect(result.reason).toBe(SNAPSHOT_SKIP_REASONS.NO_LOCAL_DB);
  });

  it('skips when snapshot_to aliases the live DB (self-reference)', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'a', namespace: 'learnings' }]);
    const result = await autoSnapshotAtSessionStart({
      projectRoot: root,
      config: configWithSnapshotTo(root, memoryDbPath(root)),
    });
    expect(result.snapshotted).toBe(false);
    expect(result.reason).toBe(SNAPSHOT_SKIP_REASONS.SELF_REFERENCE);
  });

  it('skips when the snapshot is already current (DB has not advanced)', async () => {
    const root = await makeRoot();
    const dbPath = memoryDbPath(root);
    await makeDbWith(dbPath, [{ key: 'a', namespace: 'learnings' }]);
    const snap = join(root, 'seed.db');
    const config = configWithSnapshotTo(root, snap);

    // First call produces. Then force the snapshot newer than the DB+sidecars.
    expect((await autoSnapshotAtSessionStart({ projectRoot: root, config })).snapshotted).toBe(true);
    const dbTime = Date.now() - 10_000;
    setMtime(dbPath, dbTime);
    if (existsSync(`${dbPath}-wal`)) setMtime(`${dbPath}-wal`, dbTime);
    if (existsSync(`${dbPath}-shm`)) setMtime(`${dbPath}-shm`, dbTime);
    setMtime(snap, Date.now());
    const before = statSync(snap).mtimeMs;

    const result = await autoSnapshotAtSessionStart({ projectRoot: root, config });
    expect(result.snapshotted).toBe(false);
    expect(result.reason).toBe(SNAPSHOT_SKIP_REASONS.FRESH);
    // Confirm it did NOT rewrite the snapshot.
    expect(statSync(snap).mtimeMs).toBe(before);
  });

  it('re-produces when the DB has advanced past the snapshot', async () => {
    const root = await makeRoot();
    const dbPath = memoryDbPath(root);
    await makeDbWith(dbPath, [{ key: 'a', namespace: 'learnings' }]);
    const snap = join(root, 'seed.db');
    const config = configWithSnapshotTo(root, snap);

    expect((await autoSnapshotAtSessionStart({ projectRoot: root, config })).snapshotted).toBe(true);
    // Force the snapshot OLDER than the DB → it must re-produce.
    setMtime(snap, Date.now() - 10_000);
    setMtime(dbPath, Date.now());

    const result = await autoSnapshotAtSessionStart({ projectRoot: root, config });
    expect(result.snapshotted).toBe(true);
    expect(rowCount(snap)).toBe(1);
  });
});
