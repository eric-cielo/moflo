/**
 * Tests for reconciling team-artifact sync (#1463) — the half the original
 * additive implementation could not do: corrections, deletions, and the
 * refusal to touch anything the other side never shared.
 *
 * Every conflict is driven in BOTH orderings. The pure matrix lives in
 * `durable-reconcile.test.ts`; this file proves the two real stores (a JSONL
 * file and a SQLite DB) are wired to it correctly in both directions.
 *
 * Real node:sqlite DBs + real files in tmp dirs. All paths via path.join /
 * os.tmpdir for cross-platform safety (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  exportTeamArtifact,
  importTeamArtifact,
  ensureSharedArtifactEol,
  TOMBSTONE_NAMESPACE,
  type TeamArtifactEntry,
  type TeamTombstone,
} from '../../services/team-artifact-sync.js';
import { isDurableNamespace } from '../../services/cherry-pick-learnings.js';
import { TOMBSTONE_TTL_MS } from '../../services/durable-reconcile.js';
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

/**
 * Tests care about ORDER, not absolute time, so they pass small offsets. `T`
 * anchors them just before `NOW_MS`: a bare `1_000` would be an epoch-1970
 * timestamp, i.e. older than the tombstone TTL, and every tombstone in the
 * suite would be pruned before the assertion ran.
 */
const T = (offset: number): number => NOW_MS - 1_000_000 + offset;

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-reconcile-'));
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

/** Read the rows a normal moflo read would see — every read path filters active. */
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

function rowStatus(dbPath: string, key: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT status FROM memory_entries WHERE key = ?`).get(key) as
      | { status: string }
      | undefined;
    return row?.status;
  } finally {
    db.close();
  }
}

function entry(key: string, content: string, updatedAt?: number): TeamArtifactEntry {
  return {
    namespace: 'learnings',
    key,
    content,
    type: 'semantic',
    created_at: 1_000,
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    provenance: { author: 'Teammate A', source: 'host-a', sharedAt: '2026-01-01T00:00:00.000Z' },
  };
}

function tombstone(key: string, at: number): TeamTombstone {
  return {
    namespace: TOMBSTONE_NAMESPACE,
    key,
    deleted: { namespace: 'learnings', key, at },
    provenance: { author: 'Teammate A', source: 'host-a', sharedAt: '2026-01-01T00:00:00.000Z' },
  };
}

function writeArtifact(path: string, lines: Array<TeamArtifactEntry | TeamTombstone>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

function readArtifact(path: string): Array<TeamArtifactEntry | TeamTombstone> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const liveKeys = (path: string): string[] =>
  readArtifact(path)
    .filter((l) => l.namespace !== TOMBSTONE_NAMESPACE)
    .map((l) => l.key)
    .sort();

const tombstoneKeys = (path: string): string[] =>
  readArtifact(path)
    .filter((l): l is TeamTombstone => l.namespace === TOMBSTONE_NAMESPACE)
    .map((l) => l.deleted.key)
    .sort();

describe('exportTeamArtifact — deletions become tombstones (#1463)', () => {
  it('replaces a locally archived entry with a tombstone', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('purged', 'was shared', T(1_000)), entry('kept', 'still here', T(1_000))]);
    await seedDb(memoryDbPath(root), [
      { key: 'purged', content: 'was shared', updatedAt: T(2_000), status: 'archived' },
      { key: 'kept', content: 'still here', updatedAt: T(1_000) },
    ]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });

    expect(report.deleted).toBe(1);
    expect(liveKeys(artifact)).toEqual(['kept']);
    expect(tombstoneKeys(artifact)).toEqual(['purged']);
    expect(report.total).toBe(1);
    expect(report.tombstones).toBe(1);
  });

  it('does not tombstone an entry the artifact never held', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('shared', 'v1', T(1_000))]);
    await seedDb(memoryDbPath(root), [
      { key: 'shared', content: 'v1', updatedAt: T(1_000) },
      { key: 'never-shared', content: 'local only', updatedAt: T(2_000), status: 'archived' },
    ]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(report.deleted).toBe(0);
    expect(tombstoneKeys(artifact)).toEqual([]);
  });

  it('restores an entry re-created locally after a purge, over its tombstone', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [tombstone('lesson', T(1_000))]);
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'learned it again', updatedAt: T(2_000) }]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(report.resurrected).toBe(1);
    expect(liveKeys(artifact)).toEqual(['lesson']);
    expect(tombstoneKeys(artifact)).toEqual([]);
  });

  it('lets the purge stand when the tombstone is newer — the same pair, reversed', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [tombstone('lesson', T(3_000))]);
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'stale local copy', updatedAt: T(2_000) }]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(report.resurrected).toBe(0);
    expect(report.keptRemote).toBe(1);
    expect(tombstoneKeys(artifact)).toEqual(['lesson']);
  });
});

describe('exportTeamArtifact — housekeeping', () => {
  it('prunes tombstones past the TTL and keeps the ones inside it', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [
      tombstone('ancient', NOW_MS - TOMBSTONE_TTL_MS - 1),
      tombstone('recent', NOW_MS - 1_000),
    ]);
    await seedDb(memoryDbPath(root), [{ key: 'unrelated', content: 'v1', updatedAt: T(1_000) }]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(report.prunedTombstones).toBe(1);
    expect(tombstoneKeys(artifact)).toEqual(['recent']);
  });

  it('leaves a git-tracked artifact untouched when nothing changed', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    await seedDb(memoryDbPath(root), [{ key: 'a', content: 'v1', updatedAt: T(1_000) }]);

    const first = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(first.wrote).toBe(true);
    const stamp = statSync(artifact).mtimeMs;

    const second = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(second.wrote).toBe(false);
    expect(second.added).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(statSync(artifact).mtimeMs).toBe(stamp);
  });
});

describe('importTeamArtifact — corrections and deletions land (#1463)', () => {
  it('updates a local row from a newer artifact entry', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('lesson', 'corrected by a teammate', T(3_000))]);
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'stale', updatedAt: T(1_000) }]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.updated).toBe(1);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'lesson', content: 'corrected by a teammate' }]);
  });

  it('keeps the local row when it is newer — the same pair, reversed', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('lesson', 'stale artifact text', T(1_000))]);
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'corrected locally', updatedAt: T(3_000) }]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.updated).toBe(0);
    expect(report.keptLocal).toBe(1);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'lesson', content: 'corrected locally' }]);
  });

  it('archives a local row on a newer tombstone, so it leaves every read path', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [tombstone('purged', T(3_000)), entry('kept', 'v1', T(1_000))]);
    await seedDb(memoryDbPath(root), [
      { key: 'purged', content: 'doomed', updatedAt: T(1_000) },
      { key: 'kept', content: 'v1', updatedAt: T(1_000) },
    ]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.deleted).toBe(1);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'kept', content: 'v1' }]);
    // Archived, not dropped — the row is the evidence that lets the deletion
    // reach the next store, and the timestamp a later re-creation must beat.
    expect(rowStatus(memoryDbPath(root), 'purged')).toBe('archived');
  });

  it('does NOT delete an entry re-created after the purge — the same pair, reversed', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [tombstone('lesson', T(1_000))]);
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'learned it again', updatedAt: T(3_000) }]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.deleted).toBe(0);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'lesson', content: 'learned it again' }]);
  });

  it('restores a locally archived row when the artifact has a newer entry', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('lesson', 'a teammate re-learned it', T(3_000))]);
    await seedDb(memoryDbPath(root), [
      { key: 'lesson', content: 'purged here', updatedAt: T(1_000), status: 'archived' },
    ]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.resurrected).toBe(1);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'lesson', content: 'a teammate re-learned it' }]);
  });
});

describe('importTeamArtifact — local-only work is never touched', () => {
  // The regression that matters most (#1463 acceptance criteria): a purge must
  // never reach an entry authored here and not yet exported.
  it('leaves a local-only row alone, with tombstones present in the artifact', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [tombstone('theirs', T(9_000)), entry('shared', 'v1', T(1_000))]);
    await seedDb(memoryDbPath(root), [
      { key: 'shared', content: 'v1', updatedAt: T(1_000) },
      { key: 'mine', content: 'never exported', updatedAt: T(1_000) },
    ]);

    importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(activeRows(memoryDbPath(root)).map((r) => r.key)).toEqual(['mine', 'shared']);
  });

  it('leaves a local-only row alone when the artifact holds no tombstones at all', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('shared', 'v1', T(1_000))]);
    await seedDb(memoryDbPath(root), [{ key: 'mine', content: 'never exported', updatedAt: T(1_000) }]);

    importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(activeRows(memoryDbPath(root)).map((r) => r.key)).toEqual(['mine', 'shared']);
  });
});

describe('artifact lines with no updated_at (written before #1463)', () => {
  // Asymmetric on purpose: whichever side has real evidence wins. On import the
  // artifact line has none, so it must never clobber a local row; on export the
  // local row does, which is what pushes a correction into a legacy artifact.
  it('still seeds a store that lacks the key', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('legacy', 'from an old artifact')]);
    await seedDb(memoryDbPath(root), []);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.imported).toBe(1);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'legacy', content: 'from an old artifact' }]);
  });

  it('never overwrites an existing local row', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('legacy', 'stale artifact text')]);
    await seedDb(memoryDbPath(root), [{ key: 'legacy', content: 'corrected locally', updatedAt: T(1) }]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.updated).toBe(0);
    expect(activeRows(memoryDbPath(root))).toEqual([{ key: 'legacy', content: 'corrected locally' }]);
  });
});

describe('timestamps survive a round trip', () => {
  // Import used to bind created_at into BOTH columns, flattening the one value
  // last-writer-wins depends on. A store that loses updated_at on every import
  // can never win a later comparison it should.
  it('preserves created_at and updated_at through export and import', async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    const artifact = join(rootA, 'team.jsonl');

    const created = T(1_000);
    const edited = T(7_000);
    await makeMemoryDb(memoryDbPath(rootA), MEMORY_SCHEMA_V3, (db: FixtureDb) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        ['id-1', 'lesson', 'learnings', 'v2', created, edited],
      );
    });

    exportTeamArtifact({ projectRoot: rootA, artifactPath: artifact, sharedAt: NOW_ISO });
    const line = readArtifact(artifact)[0] as TeamArtifactEntry;
    expect(line.created_at).toBe(created);
    expect(line.updated_at).toBe(edited);

    await seedDb(memoryDbPath(rootB), []);
    importTeamArtifact({ projectRoot: rootB, artifactPath: artifact });

    const db = new DatabaseSync(memoryDbPath(rootB));
    try {
      const row = db
        .prepare(`SELECT created_at, updated_at FROM memory_entries WHERE key = 'lesson'`)
        .get() as { created_at: number; updated_at: number };
      expect(row.created_at).toBe(created);
      expect(row.updated_at).toBe(edited);
    } finally {
      db.close();
    }
  });
});

describe('legacy lines get a timestamp backfilled on export', () => {
  // A pre-#1463 line stamps 0 forever otherwise: content-equal lines are never
  // rewritten, so the ambiguity would never retire and every future comparison
  // against a real timestamp would be decided by the missing field.
  it('backfills updated_at without disturbing the original provenance', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('lesson', 'same text')]); // no updated_at
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'same text', updatedAt: T(4_000) }]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(report.backfilled).toBe(1);
    expect(report.updated).toBe(0); // content matched — this is not a rewrite

    const line = readArtifact(artifact)[0] as TeamArtifactEntry;
    expect(line.updated_at).toBe(T(4_000));
    expect(line.content).toBe('same text');
    expect(line.provenance.author).toBe('Teammate A'); // untouched
  });

  it('leaves a line this machine does not hold without a timestamp', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('theirs', 'never imported here')]);
    await seedDb(memoryDbPath(root), []);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(report.backfilled).toBe(0);
    expect((readArtifact(artifact)[0] as TeamArtifactEntry).updated_at).toBeUndefined();
  });

  it('is a one-time migration — the next export is a no-op', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('lesson', 'same text')]);
    await seedDb(memoryDbPath(root), [{ key: 'lesson', content: 'same text', updatedAt: T(4_000) }]);

    exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    const second = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(second.backfilled).toBe(0);
    expect(second.wrote).toBe(false);
  });
});

describe('backward compatibility with pre-#1463 clients', () => {
  // A rename of the marker namespace would silently break deletion handling for
  // every client that has not upgraded. These two properties are the whole
  // compatibility mechanism, so they are pinned literally.
  it('marks tombstones with a namespace old clients treat as non-durable', () => {
    expect(TOMBSTONE_NAMESPACE).toBe('__moflo_tombstone__');
    expect(isDurableNamespace(TOMBSTONE_NAMESPACE)).toBe(false);
  });

  it('emits tombstone lines a 4.12.11 parser accepts and then skips', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [entry('purged', 'was shared', T(1_000))]);
    await seedDb(memoryDbPath(root), [
      { key: 'purged', content: 'was shared', updatedAt: T(2_000), status: 'archived' },
    ]);
    exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW_ISO });

    // 4.12.11's readArtifact: JSON.parse, then require string namespace + key.
    // 4.12.11's import: isDurableNamespace(namespace) === false -> skippedNonDurable.
    for (const raw of readFileSync(artifact, 'utf-8').split(/\r?\n/).filter((l) => l.trim())) {
      const parsed = JSON.parse(raw);
      expect(typeof parsed.namespace).toBe('string');
      expect(typeof parsed.key).toBe('string');
    }
    const lines = readArtifact(artifact);
    expect(lines).toHaveLength(1);
    expect(isDurableNamespace(lines[0].namespace)).toBe(false);
  });

  it('lets the tombstone stand when an old client re-appends the live line beside it', async () => {
    // An old client keys tombstones under the marker namespace, so the retired
    // key looks absent to it and its export re-adds a live line — with no
    // updated_at, because it never wrote one. The tombstone must still win.
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    writeArtifact(artifact, [tombstone('purged', T(5_000)), entry('purged', 're-added by an old client')]);
    await seedDb(memoryDbPath(root), []);

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.imported).toBe(0);
    expect(activeRows(memoryDbPath(root))).toEqual([]);
  });
});

describe('round trip between two machines', () => {
  it('carries an edit and a purge from A to B', async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    const artifact = join(rootA, 'shared', 'team.jsonl');

    await seedDb(memoryDbPath(rootA), [
      { key: 'edited', content: 'v1', updatedAt: T(1_000) },
      { key: 'doomed', content: 'v1', updatedAt: T(1_000) },
    ]);
    await seedDb(memoryDbPath(rootB), [
      { key: 'edited', content: 'v1', updatedAt: T(1_000) },
      { key: 'doomed', content: 'v1', updatedAt: T(1_000) },
      { key: 'b-only', content: 'authored on B', updatedAt: T(1_000) },
    ]);

    // A and B share a baseline first — that is the state a correction and a
    // purge have to travel over.
    exportTeamArtifact({ projectRoot: rootA, artifactPath: artifact, sharedAt: NOW_ISO });
    importTeamArtifact({ projectRoot: rootB, artifactPath: artifact });

    // A corrects one entry and purges another, then re-exports.
    const dbA = new DatabaseSync(memoryDbPath(rootA));
    dbA.prepare(`UPDATE memory_entries SET content = ?, updated_at = ? WHERE key = 'edited'`).run('v2 corrected', T(5_000));
    dbA.prepare(`UPDATE memory_entries SET status = 'archived', updated_at = ? WHERE key = 'doomed'`).run(T(5_000));
    dbA.close();
    const exported = exportTeamArtifact({ projectRoot: rootA, artifactPath: artifact, sharedAt: NOW_ISO });
    expect(exported.updated).toBe(1);
    expect(exported.deleted).toBe(1);

    // B imports.
    const imported = importTeamArtifact({ projectRoot: rootB, artifactPath: artifact });
    expect(imported.updated).toBe(1);
    expect(imported.deleted).toBe(1);
    expect(activeRows(memoryDbPath(rootB))).toEqual([
      { key: 'b-only', content: 'authored on B' },
      { key: 'edited', content: 'v2 corrected' },
    ]);
  });

  it('converges: a second import changes nothing', async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    const artifact = join(rootA, 'shared', 'team.jsonl');
    await seedDb(memoryDbPath(rootA), [
      { key: 'a', content: 'v1', updatedAt: T(1_000) },
      { key: 'gone', content: 'v1', updatedAt: T(2_000), status: 'archived' },
    ]);
    await seedDb(memoryDbPath(rootB), [{ key: 'gone', content: 'v1', updatedAt: T(1_000) }]);
    exportTeamArtifact({ projectRoot: rootA, artifactPath: artifact, sharedAt: NOW_ISO });

    importTeamArtifact({ projectRoot: rootB, artifactPath: artifact });
    const second = importTeamArtifact({ projectRoot: rootB, artifactPath: artifact });
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.resurrected).toBe(0);
  });
});

describe('ensureSharedArtifactEol — the artifact is git-tracked in someone else\'s repo', () => {
  // Rule #1: moflo always writes the artifact with \n. On a Windows checkout
  // with core.autocrlf, git hands back CRLF — so every export rewrites the
  // whole file, and a merge of two divergent artifacts conflicts on every
  // line, which is exactly the merge-friendliness JSONL was chosen for.
  const readAttrs = (root: string): string => readFileSync(join(root, '.gitattributes'), 'utf-8');

  it('creates a .gitattributes pinning the artifact to LF', async () => {
    const root = await makeRoot();
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');

    expect(ensureSharedArtifactEol(root, artifact)).toBe('created');
    expect(readAttrs(root)).toContain('/.moflo/shared/learnings.jsonl text eol=lf');
  });

  it('appends to an existing .gitattributes without disturbing it', async () => {
    const root = await makeRoot();
    writeFileSync(join(root, '.gitattributes'), '*.png binary\n', 'utf-8');
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');

    expect(ensureSharedArtifactEol(root, artifact)).toBe('updated');
    const attrs = readAttrs(root);
    expect(attrs).toContain('*.png binary');
    expect(attrs).toContain('/.moflo/shared/learnings.jsonl text eol=lf');
  });

  it('is idempotent', async () => {
    const root = await makeRoot();
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');
    ensureSharedArtifactEol(root, artifact);
    const first = readAttrs(root);

    expect(ensureSharedArtifactEol(root, artifact)).toBe('unchanged');
    expect(readAttrs(root)).toBe(first);
  });

  it("leaves a consumer's own rule for the same path exactly as written", async () => {
    const root = await makeRoot();
    writeFileSync(join(root, '.gitattributes'), '/.moflo/shared/learnings.jsonl text eol=crlf\n', 'utf-8');
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');

    expect(ensureSharedArtifactEol(root, artifact)).toBe('unchanged');
    expect(readAttrs(root)).toContain('eol=crlf');
  });

  it('writes no rule for an artifact outside the project', async () => {
    const root = await makeRoot();
    const elsewhere = await makeRoot();
    expect(ensureSharedArtifactEol(root, join(elsewhere, 'learnings.jsonl'))).toBe('unchanged');
    expect(existsSync(join(root, '.gitattributes'))).toBe(false);
  });

  it('preserves a CRLF file\'s line endings instead of rewriting the whole file', async () => {
    // The narrow-edit promise is only kept if the writer hands back the EOL
    // style it was given — otherwise a Windows consumer gets a full-file diff
    // on every export, which is what this rule exists to prevent.
    const root = await makeRoot();
    writeFileSync(join(root, '.gitattributes'), '*.png binary\r\n*.jpg binary\r\n', 'utf-8');
    ensureSharedArtifactEol(root, join(root, '.moflo', 'shared', 'learnings.jsonl'));

    const attrs = readAttrs(root);
    expect(attrs).toContain('*.png binary\r\n');
    expect(attrs.split('\r\n').length).toBeGreaterThan(3);
    // No bare LF introduced anywhere.
    expect(/[^\r]\n/.test(attrs)).toBe(false);
  });

  it('escapes a path with spaces or glob metacharacters', async () => {
    const root = await makeRoot();
    // `--to` is caller-supplied: unescaped, `team notes.jsonl` parses as the
    // pattern `team`, and a `*` would match files the user never named.
    ensureSharedArtifactEol(root, join(root, '.moflo', 'team notes[1].jsonl'));

    const attrs = readAttrs(root);
    // Quoted because of the space, and the brackets escaped so the pattern
    // matches the literal filename rather than a one-character class. The
    // backslashes are doubled: git un-quotes the C-string first, leaving the
    // single backslashes the glob layer needs.
    expect(attrs).toMatch(/^".*" text eol=lf$/m);
    expect(attrs).toContain('team notes');
    expect(attrs).toContain('\\\\[1\\\\]');
  });

  it('recognises its own escaped rule on a second run', async () => {
    const root = await makeRoot();
    const artifact = join(root, '.moflo', 'team notes[1].jsonl');
    ensureSharedArtifactEol(root, artifact);
    const first = readAttrs(root);

    expect(ensureSharedArtifactEol(root, artifact)).toBe('unchanged');
    expect(readAttrs(root)).toBe(first);
  });

  it('writes the pattern with forward slashes on every platform', async () => {
    const root = await makeRoot();
    ensureSharedArtifactEol(root, join(root, '.moflo', 'shared', 'learnings.jsonl'));
    expect(readAttrs(root)).not.toContain('\\\\');
  });
});
