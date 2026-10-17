/**
 * Integration tests for `flo memory team-export` / `team-import` (#1234).
 *
 * Drives the command actions directly with a mocked `findProjectRoot` pinned to
 * a tmp root, exercising default-path resolution (the `.moflo/shared/learnings/`
 * directory, #1506), migration of an old `learnings.jsonl` beside it, the
 * `.gitignore` track side-effect, and the export→import round-trip through the
 * real services. Cross-platform paths via path.join / os.tmpdir (Rule #1).
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
import { writeJsonlArtifact, liveArtifactKeys } from '../_helpers/team-artifact.js';
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

function seedLearnings(
  root: string,
  rows: Array<{ key: string; namespace: string; content?: string; updatedAt?: number; status?: string }>,
): Promise<void> {
  return makeMemoryDb(memoryDbPath(root), MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      const ts = r.updatedAt ?? Date.now();
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `id-${r.namespace}-${r.key}`,
          r.key,
          r.namespace,
          r.content ?? `content-${r.key}`,
          ts,
          ts,
          r.status ?? 'active',
        ],
      );
    }
  });
}

/** Capture what the command actually prints, so the summary itself is covered. */
async function captureRun(
  cmd: Command,
  root: string,
  flags: Record<string, string> = {},
): Promise<{ result: CommandResult; printed: string }> {
  const { output } = await import('../../output.js');
  const chunks: string[] = [];
  const sinks = ['printSuccess', 'printInfo', 'printWarning', 'printError'] as const;
  const spies = sinks.map((name) =>
    vi.spyOn(output as never, name as never).mockImplementation(((msg: string) => {
      chunks.push(String(msg));
    }) as never),
  );
  try {
    const result = await run(cmd, root, flags);
    return { result, printed: chunks.join('\n') };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
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

    const artifact = join(root, '.moflo', 'shared', 'learnings');
    expect(liveArtifactKeys(artifact)).toEqual(['l1']);
    // The directory is the artifact now (#1506) — no JSONL file is ever written.
    expect(existsSync(join(root, '.moflo', 'shared', 'learnings.jsonl'))).toBe(false);

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

describe('the team-export / team-import summaries report every category (#1463)', () => {
  // The old summary named only the appends, which read as "everything was
  // shared" while 32 corrections and 34 deletions sat unpropagated. The
  // rendering is the part that failed, so the rendering is what gets asserted.
  it('names corrections and retirements, not just appends', async () => {
    const root = await makeRoot();
    const artifact = join(root, '.moflo', 'shared', 'learnings');
    await seedLearnings(root, [
      { key: 'corrected', namespace: 'learnings', content: 'v1', updatedAt: Date.now() - 5_000 },
      { key: 'retired', namespace: 'learnings', content: 'v1', updatedAt: Date.now() - 5_000 },
    ]);
    await run(teamExport, root);

    // Correct one entry and purge another, then re-export.
    const db = new DatabaseSync(memoryDbPath(root));
    db.prepare(`UPDATE memory_entries SET content = ?, updated_at = ? WHERE key = 'corrected'`).run('v2', Date.now());
    db.prepare(`UPDATE memory_entries SET status = 'archived', updated_at = ? WHERE key = 'retired'`).run(Date.now());
    db.close();

    const { result, printed } = await captureRun(teamExport, root);
    expect(result.success).toBe(true);
    expect(printed).toMatch(/1 corrected/);
    expect(printed).toMatch(/1 retired/);
    expect(existsSync(artifact)).toBe(true);
  });

  it('warns when a local change was NOT shared because the artifact is newer', async () => {
    const root = await makeRoot();
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');
    await seedLearnings(root, [{ key: 'k', namespace: 'learnings', content: 'local', updatedAt: 1_000 }]);
    writeJsonlArtifact(artifact, [
      {
        namespace: 'learnings',
        key: 'k',
        content: 'newer from a teammate',
        type: 'semantic',
        updated_at: Date.now(),
        provenance: { author: 'A', source: 'h', sharedAt: 'x' },
      },
    ]);

    const { printed } = await captureRun(teamExport, root);
    expect(printed).toMatch(/NOT shared/);
    expect(printed).toMatch(/team-import/);
  });

  it('reports what an import applied beyond plain inserts', async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    await seedLearnings(rootA, [{ key: 'k', namespace: 'learnings', content: 'v2', updatedAt: Date.now() }]);
    await seedLearnings(rootB, [{ key: 'k', namespace: 'learnings', content: 'v1', updatedAt: 1_000 }]);
    await run(teamExport, rootA);

    const artifact = join(rootA, '.moflo', 'shared', 'learnings');
    const { printed } = await captureRun(teamImport, rootB, { from: artifact });
    expect(printed).toMatch(/1 corrected/);
  });
});

describe('team-export migrates an old JSONL artifact (#1506)', () => {
  it('folds the default learnings.jsonl into the directory and removes it', async () => {
    const root = await makeRoot();
    const jsonl = join(root, '.moflo', 'shared', 'learnings.jsonl');
    const provenance = { author: 'A', source: 'h', sharedAt: '2026-01-01T00:00:00.000Z' };
    writeJsonlArtifact(jsonl, [
      { namespace: 'learnings', key: 'from-teammate', content: 'shared earlier', type: 'semantic', updated_at: 1_000, provenance },
      { namespace: 'knowledge', key: 'kb-teammate', content: 'kb', type: 'semantic', updated_at: 1_000, provenance },
    ]);
    await seedLearnings(root, [{ key: 'mine', namespace: 'learnings' }]);

    const { result, printed } = await captureRun(teamExport, root);

    expect(result.success).toBe(true);
    expect(printed).toMatch(/Migrated \d+ entr/);
    expect(existsSync(jsonl)).toBe(false);
    const dir = join(root, '.moflo', 'shared', 'learnings');
    expect(existsSync(dir)).toBe(true);
    expect(liveArtifactKeys(dir)).toEqual(['from-teammate', 'kb-teammate', 'mine']);
    expect(readFileSync(join(root, '.gitattributes'), 'utf-8')).toContain('/.moflo/shared/learnings/** text eol=lf');
  });
});
