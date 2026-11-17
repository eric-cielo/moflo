/**
 * Entry files depend only on the entry, never on the export (#1526).
 *
 * Every export used to stamp its own time into each entry it wrote. The
 * pre-commit export publishes everything a branch lacks, so parallel branches
 * commit the same learnings — harmless on its own, since git merges identical
 * adds cleanly, but the per-export `sharedAt` made those adds byte-different
 * and every second merge conflicted. These tests pin that the same learning
 * exports to identical bytes at any time, on any branch, from a machine that
 * imported it — and, with real `git merge`, that the reported scenario merges.
 *
 * Real node:sqlite DBs, real files and real git repos in tmp dirs. All paths
 * via path.join / os.tmpdir (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  exportTeamArtifact,
  importTeamArtifact,
  TOMBSTONE_NAMESPACE,
  type TeamArtifactEntry,
  type TeamArtifactLine,
} from '../../services/team-artifact-sync.js';
import { entryFilePath, readArtifact } from '../../services/team-artifact-store.js';
import { reconcileId } from '../../services/durable-reconcile.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';
import { writeDir, git, hasGit } from '../_helpers/team-artifact.js';

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

const savedEnv = process.env.MOFLO_TEAM_ARTIFACT;
beforeEach(() => {
  delete process.env.MOFLO_TEAM_ARTIFACT;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOFLO_TEAM_ARTIFACT;
  else process.env.MOFLO_TEAM_ARTIFACT = savedEnv;
});

const NOW_MS = Date.parse('2026-06-28T00:00:00.000Z');
const UPDATED = NOW_MS - 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
/** Two export times an hour apart — the gap between the two commits in #1526. */
const EARLIER = iso(NOW_MS - 3_000_000);
const LATER = iso(NOW_MS);

async function makeRoot(prefix = 'moflo-team-1526-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface Row {
  key: string;
  content?: string;
  updatedAt?: number;
  status?: 'active' | 'archived';
}

function seedDb(root: string, rows: Row[]): Promise<void> {
  return makeMemoryDb(memoryDbPath(root), MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      const ts = r.updatedAt ?? UPDATED;
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`id-${r.key}`, r.key, 'learnings', r.content ?? `content-${r.key}`, ts, ts, r.status ?? 'active'],
      );
    }
  });
}

/** Run SQL against an existing store in place (no schema re-run). */
function updateDb(root: string, apply: (db: { run(sql: string, params?: unknown[]): void }) => void): void {
  const db = new DatabaseSync(memoryDbPath(root));
  try {
    apply({ run: (sql, params = []) => void db.prepare(sql).run(...(params as never[])) });
  } finally {
    db.close();
  }
}

/** A machine whose store holds `rows`. */
async function machine(rows: Row[]): Promise<string> {
  const root = await makeRoot('moflo-team-1526-machine-');
  await seedDb(root, rows);
  return root;
}

const fileFor = (dir: string, key: string): string => entryFilePath(dir, reconcileId('learnings', key));
const lineFor = (dir: string, key: string): TeamArtifactLine | undefined =>
  readArtifact(dir).lines.get(reconcileId('learnings', key));

/** A teammate's line, written the way a #1526 exporter writes it. */
function teammateLine(key: string, content: string, updatedAt: number): TeamArtifactEntry {
  return {
    namespace: 'learnings',
    key,
    content,
    type: 'semantic',
    created_at: updatedAt,
    updated_at: updatedAt,
    provenance: { author: 'Teammate A', source: 'host-a', sharedAt: iso(updatedAt) },
  };
}


describe('entry files carry no export time', () => {
  it('stamps sharedAt with the entry’s own updated_at, not the export time', async () => {
    const root = await machine([{ key: 'alpha' }]);
    const dir = join(root, 'learnings');

    exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: LATER });

    const line = lineFor(dir, 'alpha') as TeamArtifactEntry;
    expect(line.provenance.sharedAt).toBe(iso(UPDATED));
  });

  it('writes the same learning to byte-identical files at different export times', async () => {
    const root = await machine([{ key: 'alpha' }]);
    const first = join(root, 'branch-a');
    const second = join(root, 'branch-b');

    exportTeamArtifact({ projectRoot: root, artifactPath: first, sharedAt: EARLIER });
    exportTeamArtifact({ projectRoot: root, artifactPath: second, sharedAt: LATER });

    expect(readFileSync(fileFor(second, 'alpha'), 'utf-8')).toBe(readFileSync(fileFor(first, 'alpha'), 'utf-8'));
  });

  it('runs with no export time at all — the CLI no longer passes one', async () => {
    const root = await machine([{ key: 'alpha' }]);
    const dir = join(root, 'learnings');

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: dir });

    expect(report.added).toBe(1);
    expect((lineFor(dir, 'alpha') as TeamArtifactEntry).provenance.sharedAt).toBe(iso(UPDATED));
  });

  it('stamps a tombstone with its deletion time', async () => {
    const root = await machine([{ key: 'alpha', updatedAt: UPDATED - 5_000 }]);
    const dir = join(root, 'learnings');
    exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: EARLIER });
    // Archive the row locally — the shape `memory delete` leaves behind.
    updateDb(root, (db) => {
      db.run(`UPDATE memory_entries SET status = 'archived', updated_at = ? WHERE key = 'alpha'`, [UPDATED]);
    });

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: LATER });

    expect(report.deleted).toBe(1);
    const line = lineFor(dir, 'alpha')!;
    expect(line.namespace).toBe(TOMBSTONE_NAMESPACE);
    expect(line.provenance.sharedAt).toBe(iso((line as { deleted: { at: number } }).deleted.at));
  });
});

describe('a learning that arrived by import keeps its provenance', () => {
  it('re-exports an imported entry byte-identical to the teammate’s file', async () => {
    const shared = join(await makeRoot(), 'learnings');
    writeDir(shared, [teammateLine('alpha', 'from a teammate', UPDATED)]);
    const original = readFileSync(fileFor(shared, 'alpha'), 'utf-8');

    // This machine imports it, then exports into a branch that lacks it.
    const root = await machine([]);
    expect(importTeamArtifact({ projectRoot: root, artifactPath: shared }).imported).toBe(1);
    const branch = join(root, 'branch');
    exportTeamArtifact({ projectRoot: root, artifactPath: branch, sharedAt: LATER });

    expect(readFileSync(fileFor(branch, 'alpha'), 'utf-8')).toBe(original);
  });

  it('credits this machine once it edits the imported entry', async () => {
    const shared = join(await makeRoot(), 'learnings');
    writeDir(shared, [teammateLine('alpha', 'from a teammate', UPDATED)]);
    const root = await machine([]);
    importTeamArtifact({ projectRoot: root, artifactPath: shared });
    updateDb(root, (db) => {
      db.run(`UPDATE memory_entries SET content = 'corrected', updated_at = ? WHERE key = 'alpha'`, [UPDATED + 1_000]);
    });

    exportTeamArtifact({ projectRoot: root, artifactPath: shared, sharedAt: LATER });

    const line = lineFor(shared, 'alpha') as TeamArtifactEntry;
    expect(line.content).toBe('corrected');
    expect(line.provenance.author).not.toBe('Teammate A');
    expect(line.provenance.sharedAt).toBe(iso(UPDATED + 1_000));
  });

  it('credits this machine for a line written before #1526, whose sharedAt was the export time', async () => {
    const shared = join(await makeRoot(), 'learnings');
    const old = teammateLine('alpha', 'from a teammate', UPDATED);
    writeDir(shared, [{ ...old, provenance: { ...old.provenance, sharedAt: EARLIER } }]);
    const root = await machine([]);
    importTeamArtifact({ projectRoot: root, artifactPath: shared });
    const branch = join(root, 'branch');

    exportTeamArtifact({ projectRoot: root, artifactPath: branch, sharedAt: LATER });

    const line = lineFor(branch, 'alpha') as TeamArtifactEntry;
    expect(line.provenance.author).not.toBe('Teammate A');
    expect(line.provenance.sharedAt).toBe(iso(UPDATED));
  });
});


function commitAll(repo: string, msg: string): void {
  expect(git(repo, 'add', '-A').status).toBe(0);
  expect(git(repo, 'commit', '-q', '-m', msg).status).toBe(0);
}

describe('upgrading from a pre-#1526 artifact', () => {
  it('rewrites none of the files an earlier export stamped with its export time', async () => {
    const root = await machine([{ key: 'alpha' }, { key: 'bravo' }]);
    const dir = join(root, 'learnings');
    // What 4.13.7 left behind: the same entries, each stamped with the export time.
    const old = (key: string): TeamArtifactEntry => ({
      ...teammateLine(key, `content-${key}`, UPDATED),
      provenance: { author: 'Teammate A', source: 'host-a', sharedAt: EARLIER },
    });
    writeDir(dir, [old('alpha'), old('bravo')]);
    const before = ['alpha', 'bravo'].map((k) => readFileSync(fileFor(dir, k), 'utf-8'));

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: LATER });

    expect(report.wrote).toBe(false);
    expect(['alpha', 'bravo'].map((k) => readFileSync(fileFor(dir, k), 'utf-8'))).toEqual(before);
  });
});

describe.skipIf(!hasGit)('the #1526 scenario under real git merge', () => {
  /**
   * One machine's store, two branches off one base. Each branch commits an
   * export taken an hour apart; the second is merged into the first.
   */
  async function sameMachineTwoBranches(onA: (dir: string) => void): Promise<string[]> {
    const repo = await makeRoot('moflo-team-1526-git-');
    expect(git(repo, 'init', '-q').status).toBe(0);
    expect(git(repo, 'checkout', '-q', '-b', 'main').status).toBe(0);
    const dir = join(repo, 'learnings');
    const root = await machine([{ key: 'base' }]);
    exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: EARLIER });
    commitAll(repo, 'base');

    // A new learning lands in the shared store; both branches pick it up.
    updateDb(root, (db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES ('id-shared', 'shared', 'learnings', 'learned once', ?, ?, 'active')`,
        [UPDATED, UPDATED],
      );
    });
    expect(git(repo, 'checkout', '-q', '-b', 'a').status).toBe(0);
    exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: EARLIER });
    onA(dir);
    commitAll(repo, 'a');
    expect(git(repo, 'checkout', '-q', 'main').status).toBe(0);
    expect(git(repo, 'checkout', '-q', '-b', 'b').status).toBe(0);
    exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: LATER });
    commitAll(repo, 'b');
    expect(git(repo, 'checkout', '-q', 'a').status).toBe(0);

    git(repo, 'merge', '--no-edit', '-q', 'b');
    return git(repo, 'diff', '--name-only', '--diff-filter=U').out.split(/\r?\n/).filter(Boolean);
  }

  it('control: an export-time stamp in the file makes the identical add conflict', async () => {
    // What a pre-#1526 export wrote on branch a: the same entry, a different sharedAt.
    const conflicted = await sameMachineTwoBranches((dir) => {
      const line = lineFor(dir, 'shared') as TeamArtifactEntry;
      writeDir(dir, [{ ...line, provenance: { ...line.provenance, sharedAt: EARLIER } }]);
    });
    expect(conflicted).toHaveLength(1);
  });

  it('the same learning committed on two branches an hour apart merges cleanly', async () => {
    const conflicted = await sameMachineTwoBranches(() => {});
    expect(conflicted).toEqual([]);
  });
});
