/**
 * #1495 — a learnings cleanup must stick across every durable copy.
 *
 * #1375 relocated `verify:*` rows out of `learnings` in the local DB only. The
 * worktree shared store and the git-tracked team artifact still held them, so
 * the session-start seed wrote them straight back and the cleanup repeated on
 * every session without converging. These tests drive the real session-start
 * order — purge, durable sync, team import — twice, and assert the second run
 * changes nothing and no store holds a misfiled row.
 *
 * Real node:sqlite DBs in tmp dirs; paths via path.join / os.tmpdir (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { purgeEphemeralNamespaces } from '../../services/ephemeral-namespace-purge.js';
import { syncDurableAtSessionStart } from '../../services/durable-sync.js';
import { exportTeamArtifact, importTeamArtifact } from '../../services/team-artifact-sync.js';
import { readDurableSnapshot, archiveDurableRow } from '../../services/durable-store-io.js';
import { isMisfiledDurable, isRunSummaryKey } from '../../services/durable-key-rules.js';
import { buildAuditPlan, type AuditRow } from '../../memory/learnings-audit.js';
import { writeAuditState } from '../../memory/learnings-audit-state.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';

const tmpDirs: string[] = [];
const savedDurable = process.env.MOFLO_DURABLE_PATH;
const savedTeam = process.env.MOFLO_TEAM_ARTIFACT;
beforeEach(() => {
  delete process.env.MOFLO_DURABLE_PATH;
  delete process.env.MOFLO_TEAM_ARTIFACT;
});
afterEach(async () => {
  if (savedDurable === undefined) delete process.env.MOFLO_DURABLE_PATH;
  else process.env.MOFLO_DURABLE_PATH = savedDurable;
  if (savedTeam === undefined) delete process.env.MOFLO_TEAM_ARTIFACT;
  else process.env.MOFLO_TEAM_ARTIFACT = savedTeam;
  while (tmpDirs.length) {
    try {
      await rm(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows file-lock — non-fatal for tests */
    }
  }
});

const T = (offset: number): number => Date.now() - 1_000_000 + offset;

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-misfiled-1495-'));
  tmpDirs.push(dir);
  return dir;
}

interface Row {
  key: string;
  namespace?: string;
  status?: 'active' | 'archived';
  createdAt?: number;
  updatedAt?: number;
}

function seedDb(dbPath: string, rows: Row[]): Promise<void> {
  fs.mkdirSync(join(dbPath, '..'), { recursive: true });
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      const ns = r.namespace ?? 'learnings';
      const updated = r.updatedAt ?? T(1_000);
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`id-${ns}-${r.key}`, r.key, ns, `content-${r.key}`, r.createdAt ?? updated, updated, r.status ?? 'active'],
      );
    }
  });
}

function rows(dbPath: string): Array<{ key: string; namespace: string; status: string; created_at: number }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`SELECT key, namespace, status, created_at FROM memory_entries ORDER BY namespace, key`)
      .all() as Array<{ key: string; namespace: string; status: string; created_at: number }>;
  } finally {
    db.close();
  }
}

const misfiledIn = (dbPath: string) => rows(dbPath).filter((r) => isMisfiledDurable(r.namespace, r.key));

function artifactLines(artifactPath: string): Array<Record<string, any>> {
  return fs
    .readFileSync(artifactPath, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const provenance = { author: 'a', source: 'h', sharedAt: '2026-01-01T00:00:00.000Z' };

/** The launcher's order: purge → durable sync → team import. */
async function sessionStart(root: string, artifactPath: string) {
  const purge = await purgeEphemeralNamespaces({ dbPath: memoryDbPath(root) });
  const sync = await syncDurableAtSessionStart({ projectRoot: root });
  const imported = importTeamArtifact({ projectRoot: root, artifactPath });
  return { purge, sync, imported };
}

describe('#1495 misfiled rows converge across local, shared store, and team artifact', () => {
  it('a second session start changes nothing and no store holds a verify:* learning', async () => {
    const root = await makeRoot();
    const sharedPath = join(root, 'shared', 'durable.db');
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');
    process.env.MOFLO_DURABLE_PATH = sharedPath;

    await seedDb(memoryDbPath(root), [{ key: 'verify:1' }, { key: 'real-lesson' }]);
    await seedDb(sharedPath, [{ key: 'verify:1' }, { key: 'verify:2' }, { key: 'real-lesson' }]);
    fs.mkdirSync(join(artifactPath, '..'), { recursive: true });
    fs.writeFileSync(
      artifactPath,
      [
        { namespace: 'learnings', key: 'real-lesson', content: 'content-real-lesson', type: 'semantic', updated_at: T(1_000), provenance },
        { namespace: 'learnings', key: 'verify:3', content: 'v3', type: 'semantic', updated_at: T(2_000), provenance },
        { namespace: '__moflo_tombstone__', key: 'verify:1', deleted: { namespace: 'learnings', key: 'verify:1', at: T(5_000) }, provenance },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );

    const first = await sessionStart(root, artifactPath);
    expect(first.purge.relocated).toBe(1);
    expect(first.sync.seededToLocal).toBe(0);
    expect(first.sync.healedShared).toBe(2);
    expect(first.imported.skippedMisfiled).toBe(2);
    expect(first.imported.deleted).toBe(0);

    const second = await sessionStart(root, artifactPath);
    expect(second.purge.relocated).toBe(0);
    expect(second.purge.superseded).toBe(0);
    expect(second.sync.seededToLocal).toBe(0);
    expect(second.sync.flushedToShared).toBe(0);
    expect(second.sync.healedShared).toBe(0);
    expect(second.imported.imported + second.imported.deleted + second.imported.updated).toBe(0);

    expect(misfiledIn(memoryDbPath(root))).toEqual([]);
    expect(misfiledIn(sharedPath)).toEqual([]);
    // The verdict itself survives, re-filed where it belongs.
    expect(rows(memoryDbPath(root)).filter((r) => r.namespace === 'verify').map((r) => r.key)).toEqual(['verify:1']);
    // The real lesson is untouched everywhere.
    expect(rows(memoryDbPath(root)).some((r) => r.key === 'real-lesson' && r.status === 'active')).toBe(true);
    expect(rows(sharedPath).some((r) => r.key === 'real-lesson' && r.status === 'active')).toBe(true);

    // Export rewrites the artifact without any misfiled line, live or tombstone.
    const exported = exportTeamArtifact({ projectRoot: root, artifactPath, sharedAt: new Date().toISOString() });
    expect(exported.droppedMisfiled).toBe(2);
    expect(exported.wrote).toBe(true);
    const keys = artifactLines(artifactPath).map((l) => l.deleted?.key ?? l.key);
    expect(keys).toEqual(['real-lesson']);
  });

  it('readDurableSnapshot never returns a misfiled row, in either state', async () => {
    const root = await makeRoot();
    const dbPath = memoryDbPath(root);
    await seedDb(dbPath, [
      { key: 'verify:live' },
      { key: 'verify:dead', status: 'archived' },
      { key: 'kept' },
      { key: 'verify:other-ns', namespace: 'knowledge' },
    ]);
    const db = openDaemonDatabase(dbPath);
    try {
      const { records } = readDurableSnapshot(db, undefined, { withPayloads: true });
      expect([...records.values()].map((r) => `${r.namespace}/${r.key}`).sort()).toEqual([
        'knowledge/verify:other-ns',
        'learnings/kept',
      ]);
      expect(readDurableSnapshot(db, undefined, { key: 'verify:live' }).records.size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('an archived learning leaves the artifact as a content-free tombstone and is not revived elsewhere', async () => {
    const machineA = await makeRoot();
    const machineB = await makeRoot();
    const artifactPath = join(machineA, 'learnings.jsonl');
    await seedDb(memoryDbPath(machineA), [{ key: 'retire-me' }, { key: 'keep-me' }]);
    await seedDb(memoryDbPath(machineB), []);

    exportTeamArtifact({ projectRoot: machineA, artifactPath, sharedAt: new Date().toISOString() });
    importTeamArtifact({ projectRoot: machineB, artifactPath });
    expect(rows(memoryDbPath(machineB)).filter((r) => r.status === 'active').map((r) => r.key)).toEqual([
      'keep-me',
      'retire-me',
    ]);

    const db = openDaemonDatabase(memoryDbPath(machineA));
    try {
      expect(archiveDurableRow(db, 'learnings', 'retire-me', Date.now())).toBe(true);
    } finally {
      db.close();
    }
    exportTeamArtifact({ projectRoot: machineA, artifactPath, sharedAt: new Date().toISOString() });
    const retired = artifactLines(artifactPath).find((l) => (l.deleted?.key ?? l.key) === 'retire-me')!;
    expect(retired.namespace).toBe('__moflo_tombstone__');
    expect(retired.content).toBeUndefined();

    const report = importTeamArtifact({ projectRoot: machineB, artifactPath });
    expect(report.deleted).toBe(1);
    // B's own export must not publish its stale copy back over the tombstone.
    exportTeamArtifact({ projectRoot: machineB, artifactPath, sharedAt: new Date().toISOString() });
    expect(artifactLines(artifactPath).find((l) => (l.deleted?.key ?? l.key) === 'retire-me')!.namespace).toBe(
      '__moflo_tombstone__',
    );
    expect(rows(memoryDbPath(machineB)).find((r) => r.key === 'retire-me')!.status).toBe('archived');
  });

  it('imported rows keep their authoring created_at, never the import time', async () => {
    const root = await makeRoot();
    const artifactPath = join(root, 'learnings.jsonl');
    await seedDb(memoryDbPath(root), []);
    const authored = T(10);
    const edited = T(20);
    fs.writeFileSync(
      artifactPath,
      [
        { namespace: 'learnings', key: 'with-created', content: 'a', type: 'semantic', created_at: authored, updated_at: edited, provenance },
        { namespace: 'learnings', key: 'no-created', content: 'b', type: 'semantic', updated_at: edited, provenance },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    importTeamArtifact({ projectRoot: root, artifactPath });
    const byKey = new Map(rows(memoryDbPath(root)).map((r) => [r.key, Number(r.created_at)]));
    expect(byKey.get('with-created')).toBe(authored);
    expect(byKey.get('no-created')).toBe(edited);
  });

  it('seeding from the shared store keeps the source created_at', async () => {
    const root = await makeRoot();
    const sharedPath = join(root, 'shared', 'durable.db');
    process.env.MOFLO_DURABLE_PATH = sharedPath;
    await seedDb(memoryDbPath(root), []);
    const authored = T(1);
    await seedDb(sharedPath, [{ key: 'old-lesson', createdAt: authored, updatedAt: authored + 1 }]);
    await syncDurableAtSessionStart({ projectRoot: root });
    expect(Number(rows(memoryDbPath(root)).find((r) => r.key === 'old-lesson')!.created_at)).toBe(authored);
  });
});

describe('#1495 run-summary classification', () => {
  it('matches ticket-shaped keys and leaves ordinary lesson keys alone', () => {
    for (const key of ['flo-2595-customer-email-unique-done', '2679-mutation-choice', 'auth-refactor-shipped', 'x-merged']) {
      expect(isRunSummaryKey(key), key).toBe(true);
    }
    for (const key of [
      'wal-defeats-db-mtime-as-change-signal',
      'verify:1234',
      'flo-cli-routing',
      'done-means-verified',
      '2026-09-28-sqlite-wal-note',
    ]) {
      expect(isRunSummaryKey(key), key).toBe(false);
    }
  });

  it('the session-start purge counts active run summaries without moving them', async () => {
    const root = await makeRoot();
    const dbPath = memoryDbPath(root);
    await seedDb(dbPath, [
      { key: 'flo-2595-thing-done' },
      { key: '2679-mutation-choice' },
      { key: 'flo-100-old-done', status: 'archived' },
      { key: 'real-lesson' },
    ]);
    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result.runSummaries).toBe(2);
    expect(rows(dbPath).filter((r) => r.namespace === 'learnings')).toHaveLength(4);

    // A key the audit already judged no longer counts, so the notice clears
    // once a human has curated the store.
    writeAuditState(root, new Map([['2679-mutation-choice', { verdict: 'KEEP', hash: 'h', at: Date.now() }]]));
    expect((await purgeEphemeralNamespaces({ dbPath })).runSummaries).toBe(1);
  });

  it('flo memory audit-learnings nominates run summaries for a verdict', () => {
    const row = (key: string): AuditRow => ({
      id: key, key, content: `c-${key}`, embedding: null, createdAt: T(0), updatedAt: Date.now(), accessCount: 5,
    });
    const plan = buildAuditPlan([row('flo-2595-thing-done'), row('real-lesson')]);
    expect(plan.counts.runSummary).toBe(1);
    expect(plan.candidates.map((c) => [c.key, c.buckets])).toEqual([['flo-2595-thing-done', ['run-summary']]]);
  });
});
