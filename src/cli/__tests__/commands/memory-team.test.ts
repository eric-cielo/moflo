/**
 * Integration tests for `flo memory team-export` / `team-import` (#1234).
 *
 * Drives the command actions directly with a mocked `findProjectRoot` pinned to
 * a tmp root, exercising default-path resolution (`.moflo/shared/learnings.jsonl`),
 * the `.gitignore` track side-effect, and the export→import round-trip through
 * the real services. Cross-platform paths via path.join / os.tmpdir (Rule #1).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hoisted = vi.hoisted(() => ({ root: '' }));
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => hoisted.root,
}));

import { memoryCommand } from '../../commands/memory.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';
import type { CommandContext, CommandResult, Command } from '../../types.js';

const teamExport = memoryCommand.subcommands!.find((c) => c.name === 'team-export') as Command;
const teamImport = memoryCommand.subcommands!.find((c) => c.name === 'team-import') as Command;

const tmpDirs: string[] = [];
afterEach(() => vi.restoreAllMocks());
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows file-lock — non-fatal */
    }
  }
});

async function makeRoot(prefix = 'moflo-team-cmd-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function ctxWith(flags: Record<string, string>): CommandContext {
  return { args: [], flags: { _: [], ...flags }, cwd: hoisted.root, interactive: false };
}

function run(cmd: Command, root: string, flags: Record<string, string> = {}): Promise<CommandResult> {
  hoisted.root = root;
  return cmd.action!(ctxWith(flags));
}

function seedLearnings(root: string, rows: Array<{ key: string; namespace: string }>): Promise<void> {
  return makeMemoryDb(memoryDbPath(root), MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      db.run(`INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`, [
        `id-${r.namespace}-${r.key}`,
        r.key,
        r.namespace,
        `content-${r.key}`,
      ]);
    }
  });
}

describe('flo memory team-export', () => {
  it('writes the default artifact and tracks it in .gitignore', async () => {
    const root = await makeRoot();
    await seedLearnings(root, [
      { key: 'l1', namespace: 'learnings' },
      { key: 'cm', namespace: 'code-map' },
    ]);

    const res = await run(teamExport, root);
    expect(res.success).toBe(true);
    expect((res.data as { added: number }).added).toBe(1); // durable only

    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');
    expect(existsSync(artifact)).toBe(true);

    // gitignore was created so the shared subtree is tracked.
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('!/.moflo/shared/');
  });
});

describe('flo memory team-import', () => {
  it('errors when the artifact is absent', async () => {
    const root = await makeRoot();
    const res = await run(teamImport, root);
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it('round-trips: export on A, import on B surfaces the same learning', async () => {
    const devA = await makeRoot('moflo-A-');
    const devB = await makeRoot('moflo-B-');
    const artifact = join(await makeRoot('moflo-share-'), 'learnings.jsonl');

    await seedLearnings(devA, [{ key: 'shared-lesson', namespace: 'learnings' }]);
    const exp = await run(teamExport, devA, { to: artifact });
    expect((exp.data as { added: number }).added).toBe(1);

    const imp = await run(teamImport, devB, { from: artifact });
    expect(imp.success).toBe(true);
    expect((imp.data as { imported: number }).imported).toBe(1);

    const db = new DatabaseSync(memoryDbPath(devB));
    try {
      const rows = db.prepare(`SELECT namespace, key FROM memory_entries`).all();
      expect(rows).toEqual([{ namespace: 'learnings', key: 'shared-lesson' }]);
    } finally {
      db.close();
    }
  });
});
