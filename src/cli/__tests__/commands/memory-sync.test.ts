/**
 * Tests for `flo memory sync` (#1233, epic #1231).
 *
 * The sync command wraps the durable cherry-pick primitive into one
 * direction-aware verb for same-user multi-machine sharing:
 *   --to <path>    export the durable slice (learnings, knowledge) to an artifact
 *   --from <path>  merge an artifact back into the local DB
 *
 * We drive the command's `action` directly with a mocked `findProjectRoot` so we
 * can point the "project root" at a tmp dir and exercise the genuine copy path
 * (real node:sqlite DBs, no daemon). All paths go through path.join / os.tmpdir
 * for cross-platform safety (Rule #1).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// findProjectRoot is the only cwd-dependent input — pin it to a tmp root per test.
const hoisted = vi.hoisted(() => ({ root: '' }));
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => hoisted.root,
}));

import { memoryCommand } from '../../commands/memory.js';
import { output } from '../../output.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';
import type { CommandContext, CommandResult, Command } from '../../types.js';

const syncCommand = memoryCommand.subcommands!.find((c) => c.name === 'sync') as Command;

const tmpDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
});
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

async function makeRoot(prefix = 'moflo-sync-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function ctxWith(flags: Record<string, string>): CommandContext {
  return { args: [], flags: { _: [], ...flags }, cwd: hoisted.root, interactive: false };
}

/** Run the sync action against a given project root. */
function runSync(root: string, flags: Record<string, string>): Promise<CommandResult> {
  hoisted.root = root;
  return syncCommand.action!(ctxWith(flags));
}

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

describe('flo memory sync — direction validation', () => {
  it('errors when neither --to nor --from is given', async () => {
    const root = await makeRoot();
    const res = await runSync(root, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it('errors when both --to and --from are given', async () => {
    const root = await makeRoot();
    const res = await runSync(root, { to: join(root, 'a.db'), from: join(root, 'b.db') });
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  });
});

describe('flo memory sync --to (export)', () => {
  it('writes only durable namespaces to the artifact, embeddings preserved', async () => {
    const root = await makeRoot();
    const artifact = join(await makeRoot('moflo-art-'), 'durable.db');
    await makeDbWith(memoryDbPath(root), [
      { key: 'lesson-1', namespace: 'learnings', embedding: [0.1, 0.2, 0.3] },
      { key: 'kb-1', namespace: 'knowledge' },
      { key: 'cm-1', namespace: 'code-map' }, // structural — must NOT travel
    ]);

    const res = await runSync(root, { to: artifact });
    expect(res.success).toBe(true);
    expect((res.data as { copied: number }).copied).toBe(2);

    const rows = readRows(artifact);
    expect(rows.map((r) => `${r.namespace}/${r.key}`).sort()).toEqual([
      'knowledge/kb-1',
      'learnings/lesson-1',
    ]);
    const lesson = rows.find((r) => r.key === 'lesson-1');
    expect(lesson?.embedding).toBe(JSON.stringify([0.1, 0.2, 0.3]));
  });

  it('warns and no-ops when the local DB does not exist yet', async () => {
    const root = await makeRoot();
    const artifact = join(await makeRoot('moflo-art-'), 'durable.db');
    const res = await runSync(root, { to: artifact });
    expect(res.success).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  });

  it('expands a leading ~ to the home directory (cross-platform)', async () => {
    const root = await makeRoot();
    const fakeHome = await makeRoot('moflo-home-');
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows (libuv) —
    // set both so the test is platform-agnostic (Rule #1).
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      await makeDbWith(memoryDbPath(root), [{ key: 'l', namespace: 'learnings' }]);
      const res = await runSync(root, { to: '~/durable.db' });
      expect(res.success).toBe(true);
      expect(existsSync(join(fakeHome, 'durable.db'))).toBe(true);
    } finally {
      for (const k of ['HOME', 'USERPROFILE'] as const) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('warns instead of claiming a copy when --to aliases the local DB', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'l', namespace: 'learnings' }]);
    const warn = vi.spyOn(output, 'printWarning').mockImplementation(() => {});

    const res = await runSync(root, { to: memoryDbPath(root) });
    expect(res.success).toBe(true);
    expect((res.data as { copied: number }).copied).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('local memory DB itself'));
  });
});

describe('flo memory sync --from (import/merge)', () => {
  it('merges durable rows from an artifact into the local DB', async () => {
    const root = await makeRoot();
    const artifact = join(await makeRoot('moflo-art-'), 'durable.db');
    await makeDbWith(artifact, [
      { key: 'lesson-x', namespace: 'learnings', embedding: [0.4, 0.5] },
      { key: 'cm-x', namespace: 'code-map' }, // structural — filtered out on import
    ]);

    const res = await runSync(root, { from: artifact });
    expect(res.success).toBe(true);
    expect((res.data as { copied: number }).copied).toBe(1);

    const localRows = readRows(memoryDbPath(root));
    expect(localRows).toHaveLength(1);
    expect(localRows[0]).toMatchObject({ namespace: 'learnings', key: 'lesson-x' });
    expect(localRows[0].embedding).toBe(JSON.stringify([0.4, 0.5]));
  });

  it('is idempotent — re-running --from copies zero on the second pass', async () => {
    const root = await makeRoot();
    const artifact = join(await makeRoot('moflo-art-'), 'durable.db');
    await makeDbWith(artifact, [{ key: 'lesson-y', namespace: 'learnings' }]);

    const first = await runSync(root, { from: artifact });
    expect((first.data as { copied: number }).copied).toBe(1);

    const second = await runSync(root, { from: artifact });
    expect(second.success).toBe(true);
    expect((second.data as { copied: number }).copied).toBe(0); // INSERT OR IGNORE
    expect(readRows(memoryDbPath(root))).toHaveLength(1);
  });

  it('errors when the artifact does not exist', async () => {
    const root = await makeRoot();
    const res = await runSync(root, { from: join(root, 'nope.db') });
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it('warns instead of claiming a merge when --from aliases the local DB', async () => {
    const root = await makeRoot();
    await makeDbWith(memoryDbPath(root), [{ key: 'l', namespace: 'learnings' }]);
    const warn = vi.spyOn(output, 'printWarning').mockImplementation(() => {});

    const res = await runSync(root, { from: memoryDbPath(root) });
    expect(res.success).toBe(true);
    expect((res.data as { copied: number }).copied).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('local memory DB itself'));
  });

  it('warns (not errors) when the artifact is not a moflo DB', async () => {
    const root = await makeRoot();
    const notMoflo = join(await makeRoot('moflo-art-'), 'random.db');
    const db = new DatabaseSync(notMoflo);
    db.exec('CREATE TABLE unrelated (id INTEGER)');
    db.close();

    const res = await runSync(root, { from: notMoflo });
    expect(res.success).toBe(true); // schema mismatch is a graceful no-op
    expect(readRows(memoryDbPath(root))).toHaveLength(0);
  });
});

describe('flo memory sync — round-trip (#1231 repro, command layer)', () => {
  it('a learning exported from machine A appears on machine B after import', async () => {
    const machineA = await makeRoot('moflo-A-');
    const machineB = await makeRoot('moflo-B-');
    const artifact = join(await makeRoot('moflo-sync-folder-'), 'durable.db');

    await makeDbWith(memoryDbPath(machineA), [
      { key: 'worry-lesson', namespace: 'learnings', content: 'worrying does no good', embedding: [0.9] },
    ]);

    const exp = await runSync(machineA, { to: artifact });
    expect((exp.data as { copied: number }).copied).toBe(1);

    const imp = await runSync(machineB, { from: artifact });
    expect((imp.data as { copied: number }).copied).toBe(1);

    const bRows = readRows(memoryDbPath(machineB));
    expect(bRows).toEqual([{ namespace: 'learnings', key: 'worry-lesson', embedding: JSON.stringify([0.9]) }]);
  });
});
