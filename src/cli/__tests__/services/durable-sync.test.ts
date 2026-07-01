/**
 * Tests for the cross-installation durable-memory sync (#1232, epic #1231).
 *
 * Covers:
 *   - resolveDurablePath: off by default, env > config precedence, relative
 *     resolution, and the self-reference guard.
 *   - flush/seed round-trip: a learning written in worktree A reaches worktree
 *     B's local DB through a shared store (the original #1231 repro, at the
 *     service layer).
 *   - syncDurableAtSessionStart: bidirectional union, no-op when unconfigured.
 *   - writeThroughDurable: propagates durable namespaces, no-ops non-durable
 *     namespaces and the unconfigured case (byte-identical behaviour AC).
 *
 * Uses real node:sqlite DBs in tmp dirs — the sync is pure file IO with no
 * daemon, so it exercises the genuine copy path. All paths go through
 * path.join / os.tmpdir for cross-platform safety (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  resolveDurablePath,
  seedDurableFromShared,
  flushDurableToShared,
  syncDurableAtSessionStart,
  writeThroughDurable,
} from '../../services/durable-sync.js';
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

// resolveDurablePath/writeThroughDurable read MOFLO_DURABLE_PATH — keep the
// env clean between cases so one test can't leak config into the next.
const savedEnv = process.env.MOFLO_DURABLE_PATH;
beforeEach(() => {
  delete process.env.MOFLO_DURABLE_PATH;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOFLO_DURABLE_PATH;
  else process.env.MOFLO_DURABLE_PATH = savedEnv;
});

async function makeRoot(prefix = 'moflo-durable-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Config with an explicit durable_path, built off the real defaults. */
function configWithDurable(root: string, durablePath?: string): MofloConfig {
  const cfg = loadMofloConfig(root);
  cfg.memory.durable_path = durablePath;
  return cfg;
}

/** Seed a V3 memory DB at `dbPath` with the given (namespace, key) rows. */
function makeDbWith(
  dbPath: string,
  rows: Array<{ key: string; namespace: string; content?: string; embedding?: number[] }>,
): Promise<void> {
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, embedding) VALUES (?, ?, ?, ?, ?)`,
        [
          `id-${r.namespace}-${r.key}`,
          r.key,
          r.namespace,
          r.content ?? `content-${r.key}`,
          r.embedding ? JSON.stringify(r.embedding) : null,
        ],
      );
    }
  });
}

function readRows(dbPath: string): Array<{ namespace: string; key: string; embedding: string | null }> {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(
      `SELECT namespace, key, embedding FROM memory_entries ORDER BY namespace, key`,
    ).all() as Array<{ namespace: string; key: string; embedding: string | null }>;
  } finally {
    db.close();
  }
}

describe('resolveDurablePath (#1232)', () => {
  it('returns null (not-configured) when no env and no config', async () => {
    const root = await makeRoot();
    const r = resolveDurablePath(root, configWithDurable(root, undefined));
    expect(r.path).toBeNull();
    expect(r.skipped).toBe('not-configured');
  });

  it('uses memory.durable_path from config (absolute)', async () => {
    const root = await makeRoot();
    const shared = join(await makeRoot('moflo-shared-'), 'durable.db');
    const r = resolveDurablePath(root, configWithDurable(root, shared));
    expect(r.path).toBe(shared);
  });

  it('resolves a relative durable_path against the project root', async () => {
    const root = await makeRoot();
    const r = resolveDurablePath(root, configWithDurable(root, 'shared/durable.db'));
    expect(r.path).toBe(join(root, 'shared', 'durable.db'));
  });

  it('env MOFLO_DURABLE_PATH takes precedence over config', async () => {
    const root = await makeRoot();
    const envShared = join(await makeRoot('moflo-env-'), 'env-durable.db');
    process.env.MOFLO_DURABLE_PATH = envShared;
    const r = resolveDurablePath(root, configWithDurable(root, '/some/config/path.db'));
    expect(r.path).toBe(envShared);
  });

  it('guards against the durable path aliasing the local DB', async () => {
    const root = await makeRoot();
    const r = resolveDurablePath(root, configWithDurable(root, memoryDbPath(root)));
    expect(r.path).toBeNull();
    expect(r.skipped).toBe('same-as-local');
  });
});

/** Config with the worktree-sharing opt-out toggle set. */
function configWithWorktreeSharing(root: string, enabled: boolean): MofloConfig {
  const cfg = loadMofloConfig(root);
  cfg.memory.worktree_sharing = enabled;
  return cfg;
}

describe('resolveDurablePath — automatic worktree sharing (#1231 follow-up)', () => {
  it('does NOT auto-derive for a plain single checkout (no worktrees)', async () => {
    const root = await makeRoot('moflo-solo-');
    mkdirSync(join(root, '.git'), { recursive: true }); // primary checkout, no worktrees
    const r = resolveDurablePath(root, loadMofloConfig(root));
    expect(r.path).toBeNull();
    expect(r.skipped).toBe('not-configured');
  });

  it('does NOT auto-derive when there is no .git at all', async () => {
    const root = await makeRoot('moflo-nogit-');
    const r = resolveDurablePath(root, loadMofloConfig(root));
    expect(r.path).toBeNull();
    expect(r.autoWorktree).toBeUndefined();
  });

  it('auto-derives under the git common dir for a primary checkout WITH worktrees', async () => {
    const root = await makeRoot('moflo-primary-');
    mkdirSync(join(root, '.git', 'worktrees', 'wt1'), { recursive: true }); // a sibling worktree exists
    const r = resolveDurablePath(root, loadMofloConfig(root));
    expect(r.path).toBe(join(root, '.git', 'moflo', 'durable.db'));
    expect(r.autoWorktree).toBe(true);
  });

  it('auto-derives the SAME path from a linked worktree (via commondir)', async () => {
    const main = await makeRoot('moflo-main-');
    const gitdir = join(main, '.git', 'worktrees', 'wtA');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');

    const wt = await makeRoot('moflo-linked-');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);

    const r = resolveDurablePath(wt, loadMofloConfig(wt));
    // Resolves to the MAIN repo's shared .git — the same store the primary
    // checkout would derive, which is what makes worktrees converge.
    expect(r.path).toBe(join(main, '.git', 'moflo', 'durable.db'));
    expect(r.autoWorktree).toBe(true);
  });

  it('an explicit durable_path wins over auto-derivation', async () => {
    const root = await makeRoot('moflo-primary-');
    mkdirSync(join(root, '.git', 'worktrees', 'wt1'), { recursive: true });
    const explicit = join(await makeRoot('moflo-shared-'), 'durable.db');
    const r = resolveDurablePath(root, configWithDurable(root, explicit));
    expect(r.path).toBe(explicit);
    expect(r.autoWorktree).toBeUndefined();
  });

  it('memory.worktree_sharing: false disables auto-derivation', async () => {
    const root = await makeRoot('moflo-optout-');
    mkdirSync(join(root, '.git', 'worktrees', 'wt1'), { recursive: true });
    const r = resolveDurablePath(root, configWithWorktreeSharing(root, false));
    expect(r.path).toBeNull();
    expect(r.skipped).toBe('not-configured');
  });

  it('syncDurableAtSessionStart auto-creates the derived store and flags autoWorktree', async () => {
    const root = await makeRoot('moflo-primary-');
    mkdirSync(join(root, '.git', 'worktrees', 'wt1'), { recursive: true });
    await makeDbWith(memoryDbPath(root), [{ key: 'auto-lesson', namespace: 'learnings' }]);

    const report = await syncDurableAtSessionStart({ projectRoot: root, config: loadMofloConfig(root) });
    const derived = join(root, '.git', 'moflo', 'durable.db');
    expect(report.durablePath).toBe(derived);
    expect(report.autoWorktree).toBe(true);
    expect(report.flushedToShared).toBe(1);
    expect(existsSync(derived)).toBe(true); // parent dir was created on flush
    expect(readRows(derived).map((r) => r.key)).toEqual(['auto-lesson']);
  });
});

describe('flush + seed round-trip (#1231 repro at service layer)', () => {
  it('a learning in worktree A reaches worktree B via the shared store', async () => {
    const rootA = await makeRoot('moflo-wtA-');
    const rootB = await makeRoot('moflo-wtB-');
    const shared = join(await makeRoot('moflo-shared-'), 'durable.db');

    // A has a learning (with an embedding so search would work post-seed).
    await makeDbWith(memoryDbPath(rootA), [
      { key: 'lesson-1', namespace: 'learnings', content: 'worrying does no good', embedding: [0.1, 0.2, 0.3] },
      { key: 'codemap-1', namespace: 'code-map', content: 'structural — must NOT travel' },
    ]);
    // B starts empty (fresh worktree, no local DB yet).

    const flush = await flushDurableToShared(rootA, shared);
    expect(flush.copied).toBe(1); // only the learning, not the code-map row

    const seed = await seedDurableFromShared(rootB, shared);
    expect(seed.copied).toBe(1);

    const bRows = readRows(memoryDbPath(rootB));
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({ namespace: 'learnings', key: 'lesson-1' });
    // Embedding carried forward verbatim → searchable in B.
    expect(bRows[0].embedding).toBe(JSON.stringify([0.1, 0.2, 0.3]));
    // Structural namespace stayed local to A — never entered the shared store.
    expect(readRows(shared).some((r) => r.namespace === 'code-map')).toBe(false);
  });

  it('seed is a no-op when the shared store does not exist yet', async () => {
    const root = await makeRoot();
    const shared = join(await makeRoot('moflo-shared-'), 'missing.db');
    const seed = await seedDurableFromShared(root, shared);
    expect(seed.copied).toBe(0);
    expect(existsSync(memoryDbPath(root))).toBe(false);
  });
});

describe('syncDurableAtSessionStart (#1232)', () => {
  it('unions durable rows in both directions', async () => {
    const root = await makeRoot('moflo-wt-');
    const shared = join(await makeRoot('moflo-shared-'), 'durable.db');

    // Local has X; shared already has Y (from a sibling workspace).
    await makeDbWith(memoryDbPath(root), [{ key: 'local-x', namespace: 'learnings' }]);
    await makeDbWith(shared, [{ key: 'shared-y', namespace: 'learnings' }]);

    const report = await syncDurableAtSessionStart({ projectRoot: root, config: configWithDurable(root, shared) });
    expect(report.durablePath).toBe(shared);
    expect(report.flushedToShared).toBe(1); // local-x → shared
    expect(report.seededToLocal).toBe(1); // shared-y → local

    const localKeys = readRows(memoryDbPath(root)).map((r) => r.key).sort();
    const sharedKeys = readRows(shared).map((r) => r.key).sort();
    expect(localKeys).toEqual(['local-x', 'shared-y']);
    expect(sharedKeys).toEqual(['local-x', 'shared-y']);
  });

  it('is a no-op when unconfigured (no files touched)', async () => {
    const root = await makeRoot();
    const report = await syncDurableAtSessionStart({ projectRoot: root, config: configWithDurable(root, undefined) });
    expect(report.durablePath).toBeNull();
    expect(report.skipped).toBe('not-configured');
    expect(report.flushedToShared).toBe(0);
    expect(report.seededToLocal).toBe(0);
    expect(existsSync(memoryDbPath(root))).toBe(false);
  });
});

describe('writeThroughDurable (#1232)', () => {
  it('propagates a durable namespace to the shared store', async () => {
    const root = await makeRoot('moflo-wt-');
    const shared = join(await makeRoot('moflo-shared-'), 'durable.db');
    await makeDbWith(memoryDbPath(root), [{ key: 'fresh-lesson', namespace: 'learnings' }]);

    await writeThroughDurable('learnings', { projectRoot: root, config: configWithDurable(root, shared) });

    expect(readRows(shared).map((r) => r.key)).toEqual(['fresh-lesson']);
  });

  it('no-ops for a non-durable namespace', async () => {
    const root = await makeRoot('moflo-wt-');
    const shared = join(await makeRoot('moflo-shared-'), 'durable.db');
    await makeDbWith(memoryDbPath(root), [{ key: 'cm', namespace: 'code-map' }]);

    await writeThroughDurable('code-map', { projectRoot: root, config: configWithDurable(root, shared) });

    expect(existsSync(shared)).toBe(false);
  });

  it('no-ops when the feature is off (byte-identical behaviour)', async () => {
    const root = await makeRoot('moflo-wt-');
    await makeDbWith(memoryDbPath(root), [{ key: 'lesson', namespace: 'learnings' }]);
    // No durable_path configured anywhere — must not throw, must not create state.
    await expect(
      writeThroughDurable('learnings', { projectRoot: root, config: configWithDurable(root, undefined) }),
    ).resolves.toBeUndefined();
  });

  it('swallows a config/path-resolution throw — never fails the caller write', async () => {
    const root = await makeRoot('moflo-wt-');
    // A malformed config (no `.memory`) makes resolveDurablePath throw. Since the
    // caller's local write has ALREADY persisted, write-through must swallow it
    // rather than propagate (the throw used to escape the try/catch — regression
    // guard for the epic-review fix).
    await expect(
      writeThroughDurable('learnings', { projectRoot: root, config: {} as unknown as MofloConfig }),
    ).resolves.toBeUndefined();
  });
});
