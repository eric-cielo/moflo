/**
 * Tests for the one-file-per-entry team artifact (#1506).
 *
 * The sorted JSONL file put two branches' new entries on adjacent lines, which
 * git reports as one conflicting hunk — and GitHub ignores merge drivers, so
 * every merged PR left the open ones conflicting. The artifact is now a
 * directory of one file per entry, and an old JSONL artifact is migrated by the
 * next export with no reconfiguration. These tests pin: path resolution, the
 * store's read/write contract, the automatic migration, git staging, and — with
 * real `git merge`, no merge driver — that concurrent adds merge cleanly while
 * an edit racing a deletion still conflicts.
 *
 * Real node:sqlite DBs, real files and real git repos in tmp dirs. All paths
 * via path.join / os.tmpdir (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

import {
  exportTeamArtifact,
  importTeamArtifact,
  ensureSharedArtifactEol,
  stageTeamArtifact,
  TOMBSTONE_NAMESPACE,
  type TeamArtifactEntry,
  type TeamTombstone,
  type TeamArtifactLine,
} from '../../services/team-artifact-sync.js';
import {
  teamArtifactPaths,
  teamArtifactExists,
  entryFilePath,
  readArtifact,
  writeArtifact,
  lineId,
} from '../../services/team-artifact-store.js';
import { reconcileId } from '../../services/durable-reconcile.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';
import { writeJsonlArtifact } from '../_helpers/team-artifact.js';

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

const NOW_ISO = '2026-06-28T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
/** Offsets anchored just before NOW so tombstones stay inside their TTL. */
const T = (offset: number): number => NOW_MS - 1_000_000 + offset;

async function makeRoot(prefix = 'moflo-team-dir-'): Promise<string> {
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
      const ts = r.updatedAt ?? T(1_000);
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`id-${r.key}`, r.key, 'learnings', r.content ?? `content-${r.key}`, ts, ts, r.status ?? 'active'],
      );
    }
  });
}

const provenance = { author: 'Teammate A', source: 'host-a', sharedAt: '2026-01-01T00:00:00.000Z' };

function entry(key: string, content: string, updatedAt: number, namespace = 'learnings'): TeamArtifactEntry {
  return { namespace, key, content, type: 'semantic', created_at: 1_000, updated_at: updatedAt, provenance };
}

function tombstone(key: string, at: number): TeamTombstone {
  return { namespace: TOMBSTONE_NAMESPACE, key, deleted: { namespace: 'learnings', key, at }, provenance };
}

/** Write records straight into a directory artifact through the store. */
function writeDir(dir: string, lines: TeamArtifactLine[]): void {
  const prior = readArtifact(dir);
  const merged = new Map(prior.lines);
  for (const line of lines) merged.set(lineId(line), line);
  writeArtifact(merged, prior);
}

/** Every entry file under a directory artifact, as `<namespace-dir>/<file>`. */
function listEntryFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((ns) => readdirSync(join(dir, ns)).map((f) => `${ns}/${f}`))
    .sort();
}

const fileText = (dir: string, rel: string): string => readFileSync(join(dir, ...rel.split('/')), 'utf-8');
const content = (path: string, key: string): string | undefined =>
  (readArtifact(path).lines.get(reconcileId('learnings', key)) as TeamArtifactEntry | undefined)?.content;

describe('teamArtifactPaths — every configured shape resolves to one directory', () => {
  it('maps the old .jsonl default onto the directory beside it, so nobody reconfigures', async () => {
    const root = await makeRoot();
    const shared = join(root, '.moflo', 'shared');
    const expected = { dir: join(shared, 'learnings'), legacy: join(shared, 'learnings.jsonl') };

    expect(teamArtifactPaths(join(shared, 'learnings.jsonl'))).toEqual(expected);
    expect(teamArtifactPaths(join(shared, 'learnings'))).toEqual(expected);
    expect(teamArtifactPaths(`${join(shared, 'learnings')}/`)).toEqual(expected);
  });

  it('treats a dotted name as a directory, not a file extension', async () => {
    const root = await makeRoot();
    expect(teamArtifactPaths(join(root, 'team.v2')).dir).toBe(join(root, 'team.v2'));
  });

  it('migrates an existing old artifact under a non-.jsonl name to the directory named by its stem', async () => {
    const root = await makeRoot();
    writeFileSync(join(root, 'team.ndjson'), '');
    expect(teamArtifactPaths(join(root, 'team.ndjson'))).toEqual({
      dir: join(root, 'team'),
      legacy: join(root, 'team.ndjson'),
    });
  });

  it('reports an artifact present while only the unmigrated file exists', async () => {
    const root = await makeRoot();
    const configured = join(root, 'learnings.jsonl');
    expect(teamArtifactExists(configured)).toBe(false);
    writeJsonlArtifact(configured, [entry('a', 'x', T(1_000))]);
    expect(teamArtifactExists(configured)).toBe(true);
  });
});

describe('directory store — read/write contract', () => {
  it('writes one pretty-printed, newline-terminated file per entry, named by hash', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    const line = entry('some key / with: odd*chars', 'body', T(1_000));
    writeDir(dir, [line]);

    const files = listEntryFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^learnings\/[0-9a-f]{64}\.json$/);
    expect(fileText(dir, files[0])).toBe(`${JSON.stringify(line, null, 2)}\n`);
  });

  it('writes a tombstone into the file of the entry it retires', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('lesson', 'v1', T(1_000))]);
    const [before] = listEntryFiles(dir);

    writeDir(dir, [tombstone('lesson', T(2_000))]);

    expect(listEntryFiles(dir)).toEqual([before]);
    expect(JSON.parse(fileText(dir, before)).deleted.key).toBe('lesson');
  });

  it('files namespaces differing only in case apart, under one sanitised directory', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('k', 'lower', T(1_000), 'learnings'), entry('k', 'upper', T(1_000), 'Learnings')]);

    const files = listEntryFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.startsWith('learnings/'))).toBe(true);
  });

  it('rewrites only changed entries and removes the file of a dropped id', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('a', 'a1', T(1_000)), entry('b', 'b1', T(1_000)), entry('c', 'c1', T(1_000))]);
    const pathOf = (key: string): string => entryFilePath(dir, reconcileId('learnings', key));
    const old = new Date(NOW_MS - 10_000_000);
    for (const k of ['a', 'b', 'c']) utimesSync(pathOf(k), old, old);

    const prior = readArtifact(dir);
    const next = new Map(prior.lines);
    next.set(reconcileId('learnings', 'b'), entry('b', 'b2', T(2_000)));
    next.delete(reconcileId('learnings', 'c'));

    expect(writeArtifact(next, prior).touched).toBe(2);
    expect(statSync(pathOf('a')).mtimeMs).toBe(old.getTime());
    expect(existsSync(pathOf('c'))).toBe(false);
  });

  it('does not rewrite an entry that only differs by CRLF line endings', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('a', 'a1', T(1_000))]);
    const file = entryFilePath(dir, reconcileId('learnings', 'a'));
    writeFileSync(file, readFileSync(file, 'utf-8').replace(/\n/g, '\r\n'));

    const prior = readArtifact(dir);
    expect(writeArtifact(prior.lines, prior).touched).toBe(0);
  });

  it('never overwrites or removes a file that will not parse — it may hold conflict markers', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('a', 'a1', T(1_000))]);
    const file = entryFilePath(dir, reconcileId('learnings', 'a'));
    const conflicted = '<<<<<<< HEAD\n{"namespace":"learnings"}\n=======\n{}\n>>>>>>> theirs\n';
    writeFileSync(file, conflicted);

    const prior = readArtifact(dir);
    expect(prior.malformed).toBe(1);
    const result = writeArtifact(new Map([[reconcileId('learnings', 'a'), entry('a', 'a2', T(2_000))]]), prior);

    expect(result.blocked).toBe(1);
    expect(readFileSync(file, 'utf-8')).toBe(conflicted);
  });

  it('moves a hand-copied file to its canonical name, and that alone makes export write', async () => {
    const root = await makeRoot();
    await seedDb(root, []);
    const dir = join(root, 'learnings');
    const misplaced = join(dir, 'learnings', 'copied-by-hand.json');
    mkdirSync(dirname(misplaced), { recursive: true });
    writeFileSync(misplaced, JSON.stringify(entry('a', 'a1', T(1_000))));

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: NOW_ISO });

    expect(report.wrote).toBe(true);
    expect(existsSync(misplaced)).toBe(false);
    expect(existsSync(entryFilePath(dir, reconcileId('learnings', 'a')))).toBe(true);
  });

  it('drops misfiled records (#1495) on read', async () => {
    const root = await makeRoot();
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('verify:abc', 'verdict', T(1_000)), entry('real', 'lesson', T(1_000))]);

    const snapshot = readArtifact(dir);
    expect(snapshot.misfiled).toBe(1);
    expect([...snapshot.lines.values()].map((l) => l.key)).toEqual(['real']);
  });
});

describe('automatic migration from the old single-file artifact', () => {
  const legacyLines: Array<TeamArtifactLine | string> = [
    entry('one', 'first', T(1_000)),
    tombstone('two', T(1_000)),
    '{ this line is broken',
    entry('verify:misfiled', 'a verdict', T(1_000)),
    // A file left mid-conflict: both sides parse, the newer edit wins.
    '<<<<<<< HEAD',
    JSON.stringify(entry('three', 'ours, older', T(1_000))),
    '=======',
    JSON.stringify(entry('three', 'theirs, newer', T(2_000))),
    '>>>>>>> branch',
  ];

  it('session-start import reads the unmigrated file — nothing is lost before the first export', async () => {
    const root = await makeRoot();
    const configured = join(root, '.moflo', 'shared', 'learnings.jsonl');
    writeJsonlArtifact(configured, legacyLines);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: configured });

    expect(report.imported).toBe(2);
    expect(existsSync(configured)).toBe(true);
  });

  it('the next export moves every valid record into the directory, removes the file, and reports it', async () => {
    const root = await makeRoot();
    await seedDb(root, [{ key: 'local', content: 'mine', updatedAt: T(1_000) }]);
    const configured = join(root, '.moflo', 'shared', 'learnings.jsonl');
    writeJsonlArtifact(configured, legacyLines);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: configured, sharedAt: NOW_ISO });

    const dir = join(root, '.moflo', 'shared', 'learnings');
    expect(report.artifactPath).toBe(dir);
    expect(report.migratedFrom).toBe(configured);
    expect(report).toMatchObject({ migrated: 3, added: 1, skippedMalformed: 4, droppedMisfiled: 1 });
    expect(existsSync(configured)).toBe(false);
    expect(listEntryFiles(dir)).toHaveLength(4);
    expect(content(dir, 'three')).toBe('theirs, newer');

    const again = exportTeamArtifact({ projectRoot: root, artifactPath: configured, sharedAt: NOW_ISO });
    expect(again).toMatchObject({ wrote: false, migrated: 0, migratedFrom: null });
  });

  it('a newer directory entry is never rolled back by the old file', async () => {
    const root = await makeRoot();
    await seedDb(root, []);
    const dir = join(root, 'learnings');
    writeDir(dir, [entry('one', 'newer in dir', T(5_000))]);
    writeJsonlArtifact(join(root, 'learnings.jsonl'), [entry('one', 'old', T(1_000))]);

    exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: NOW_ISO });

    expect(content(dir, 'one')).toBe('newer in dir');
  });

  it('a teammate on an old release re-creating the file is folded in again', async () => {
    const root = await makeRoot();
    await seedDb(root, []);
    const configured = join(root, 'learnings.jsonl');
    writeJsonlArtifact(configured, [entry('one', 'first', T(1_000))]);
    exportTeamArtifact({ projectRoot: root, artifactPath: configured, sharedAt: NOW_ISO });
    writeJsonlArtifact(configured, [entry('two', 'from an old client', T(2_000))]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: configured, sharedAt: NOW_ISO });

    expect(report.migrated).toBe(1);
    expect(existsSync(configured)).toBe(false);
    expect(content(configured, 'two')).toBe('from an old client');
  });

  it('keeps the old file while an entry is blocked by an unparseable file', async () => {
    const root = await makeRoot();
    await seedDb(root, []);
    const dir = join(root, 'learnings');
    const blockedFile = entryFilePath(dir, reconcileId('learnings', 'one'));
    mkdirSync(dirname(blockedFile), { recursive: true });
    writeFileSync(blockedFile, '<<<<<<< HEAD\n');
    writeJsonlArtifact(join(root, 'learnings.jsonl'), [entry('one', 'only copy', T(1_000))]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: dir, sharedAt: NOW_ISO });

    expect(report.blocked).toBe(1);
    expect(report.migratedFrom).toBeNull();
    expect(existsSync(join(root, 'learnings.jsonl'))).toBe(true);
  });

  it('round-trips: export on one machine, import on another', async () => {
    const author = await makeRoot();
    const reader = await makeRoot();
    await seedDb(author, [{ key: 'shared-lesson', content: 'travel me', updatedAt: T(1_000) }]);
    const dir = join(author, 'learnings');

    expect(exportTeamArtifact({ projectRoot: author, artifactPath: dir, sharedAt: NOW_ISO }).added).toBe(1);
    expect(importTeamArtifact({ projectRoot: reader, artifactPath: dir }).imported).toBe(1);
  });
});

describe('ensureSharedArtifactEol — directory artifact', () => {
  it('pins the files inside the directory for either configured shape, idempotently', async () => {
    const root = await makeRoot();
    const shared = join(root, '.moflo', 'shared');

    expect(ensureSharedArtifactEol(root, join(shared, 'learnings.jsonl'))).toBe('created');
    expect(ensureSharedArtifactEol(root, join(shared, 'learnings'))).toBe('unchanged');
    const attrs = readFileSync(join(root, '.gitattributes'), 'utf-8');
    expect(attrs).toContain('/.moflo/shared/learnings/** text eol=lf');
    expect(attrs.match(/eol=lf/g)).toHaveLength(1);
  });
});

/**
 * Real git, no merge driver and no .gitattributes: what GitHub's mergeability
 * check sees. Identity is passed per call so a developer's global config
 * cannot change the outcome.
 */
function git(repo: string, ...args: string[]): { status: number; out: string } {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf-8' },
  );
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const hasGit = spawnSync('git', ['--version']).status === 0;

async function makeRepo(): Promise<string> {
  const repo = await makeRoot('moflo-team-git-');
  expect(git(repo, 'init', '-q').status).toBe(0);
  expect(git(repo, 'checkout', '-q', '-b', 'main').status).toBe(0);
  return repo;
}

function commitAll(repo: string, msg: string): void {
  expect(git(repo, 'add', '-A').status).toBe(0);
  expect(git(repo, 'commit', '-q', '-m', msg).status).toBe(0);
}

describe.skipIf(!hasGit)('stageTeamArtifact — old pre-commit hooks keep working', () => {
  it('stages the migration — new files and the old file deletion — when the artifact is tracked', async () => {
    const repo = await makeRepo();
    await seedDb(repo, []);
    const configured = join(repo, 'shared', 'learnings.jsonl');
    writeJsonlArtifact(configured, [entry('one', 'x', T(1_000))]);
    expect(git(repo, 'add', '--', configured).status).toBe(0);
    expect(git(repo, 'commit', '-q', '-m', 'base').status).toBe(0);

    exportTeamArtifact({ projectRoot: repo, artifactPath: configured, sharedAt: NOW_ISO });
    expect(stageTeamArtifact(repo, configured)).toBe(true);

    const staged = git(repo, 'diff', '--cached', '--name-status').out;
    expect(staged).toMatch(/^D\s+shared\/learnings\.jsonl$/m);
    expect(staged).toMatch(/^A\s+shared\/learnings\/learnings\/[0-9a-f]{64}\.json$/m);
  });

  it('stages nothing when the team never tracked the artifact', async () => {
    const repo = await makeRepo();
    await seedDb(repo, [{ key: 'one' }]);
    const dir = join(repo, 'shared', 'learnings');
    exportTeamArtifact({ projectRoot: repo, artifactPath: dir, sharedAt: NOW_ISO });

    expect(stageTeamArtifact(repo, dir)).toBe(false);
    expect(git(repo, 'diff', '--cached', '--name-only').out.trim()).toBe('');
  });
});

describe.skipIf(!hasGit)('git merge of concurrent branches (#1506)', () => {
  type Writer = (repo: string, rows: Row[]) => Promise<void>;

  /** Export the rows from a fresh "machine" into the repo's directory artifact. */
  const exportDir: Writer = async (repo, rows) => {
    const machine = await makeRoot('moflo-team-machine-');
    await seedDb(machine, rows);
    exportTeamArtifact({ projectRoot: machine, artifactPath: join(repo, 'learnings'), sharedAt: NOW_ISO });
  };

  /** What the old exporter wrote: one sorted JSONL file. */
  const writeSortedJsonl: Writer = async (repo, rows) => {
    const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : 1));
    writeJsonlArtifact(
      join(repo, 'learnings.jsonl'),
      sorted.map((r) => entry(r.key, r.content ?? '', r.updatedAt ?? T(1_000))),
    );
  };

  /** Base commit, branches `a` and `b` from it, then merge `b` into `a`. Returns conflicted paths. */
  async function mergeScenario(write: Writer, base: Row[], branchA: Row[], branchB: Row[]) {
    const repo = await makeRepo();
    await write(repo, base);
    commitAll(repo, 'base');
    expect(git(repo, 'checkout', '-q', '-b', 'a').status).toBe(0);
    await write(repo, branchA);
    commitAll(repo, 'a');
    expect(git(repo, 'checkout', '-q', 'main').status).toBe(0);
    expect(git(repo, 'checkout', '-q', '-b', 'b').status).toBe(0);
    await write(repo, branchB);
    commitAll(repo, 'b');
    expect(git(repo, 'checkout', '-q', 'a').status).toBe(0);

    git(repo, 'merge', '--no-edit', '-q', 'b');
    const conflicted = git(repo, 'diff', '--name-only', '--diff-filter=U').out.split(/\r?\n/).filter(Boolean);
    return { conflicted, repo };
  }

  const base: Row[] = [
    { key: 'alpha', content: 'a', updatedAt: T(1_000) },
    { key: 'zulu', content: 'z', updatedAt: T(1_000) },
  ];
  // Keys that sort next to each other — the shape that conflicted in JSONL.
  const addOnA: Row[] = [...base, { key: 'mike-1', content: 'from a', updatedAt: T(2_000) }];
  const addOnB: Row[] = [...base, { key: 'mike-2', content: 'from b', updatedAt: T(2_000) }];

  it('control: the same two adds conflicted in the old sorted JSONL file', async () => {
    const { conflicted } = await mergeScenario(writeSortedJsonl, base, addOnA, addOnB);
    expect(conflicted).toEqual(['learnings.jsonl']);
  });

  it('two branches that each add an entry merge with no conflict', async () => {
    const { conflicted, repo } = await mergeScenario(exportDir, base, addOnA, addOnB);
    expect(conflicted).toEqual([]);
    const keys = [...readArtifact(join(repo, 'learnings')).lines.values()].map((l) => l.key).sort();
    expect(keys).toEqual(['alpha', 'mike-1', 'mike-2', 'zulu']);
  });

  it('an edit on one branch and a deletion on the other still conflict visibly', async () => {
    const edited: Row[] = [{ key: 'alpha', content: 'corrected', updatedAt: T(2_000) }, base[1]];
    const retired: Row[] = [{ key: 'alpha', content: 'a', updatedAt: T(2_000), status: 'archived' }, base[1]];

    const { conflicted } = await mergeScenario(exportDir, base, edited, retired);

    expect(conflicted).toHaveLength(1);
    expect(basename(conflicted[0])).toMatch(/^[0-9a-f]{64}\.json$/);
  });
});
