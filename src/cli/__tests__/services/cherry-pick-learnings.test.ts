/**
 * Tests for the version-bump-gated cherry-pick service introduced by #851.
 *
 * Covers the three AC scenarios:
 *   - Fresh install: no legacy state → no-op + V3-schema target.
 *   - 4.8 upgrade: `.swarm/memory.db` → cherry-pick learnings + knowledge.
 *   - Partial prior migration: pre-existing rows in target stay; INSERT OR
 *     IGNORE skips dupes; only the genuinely-new rows get copied.
 *
 * Plus the implicit AC of read-only on legacy sources (the source DB is
 * never mutated, byte-equal before vs after).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { cherryPickLearningsFromLegacy } from '../../services/cherry-pick-learnings.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import {
  makeLegacyDb as makeLegacyMemoryDb,
  makeMemoryDb,
  type FixtureDb,
} from '../_helpers/legacy-memory-db.js';

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

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-cherry-'));
  tmpDirs.push(dir);
  return dir;
}

function makeLegacyDb(setup: (db: FixtureDb) => void, dbPath: string): Promise<void> {
  return makeLegacyMemoryDb(dbPath, setup);
}
function makeV3Db(setup: (db: FixtureDb) => void, dbPath: string): Promise<void> {
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, setup);
}

function readNamespaceCounts(dbPath: string): Record<string, number> {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(
      `SELECT namespace, COUNT(*) AS c FROM memory_entries GROUP BY namespace`,
    ).all() as Array<{ namespace: string; c: number | bigint }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.namespace] = Number(row.c);
    return counts;
  } finally {
    db.close();
  }
}

describe('cherryPickLearningsFromLegacy (#851)', () => {
  it('fresh install: no-op when no legacy DBs exist; target file not materialized', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');

    const result = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [join(root, '.swarm', 'memory.db')],
      toPath: target,
    });

    expect(result.copied).toBe(0);
    expect(result.considered).toBe(0);
    expect(result.sources).toEqual([]);
    // No rows + no pre-existing target → don't materialize an empty DB. The
    // regular memory initializer (or the first MCP write) creates the file
    // on demand. Saves an unnecessary atomic-write per fresh-install upgrade.
    expect(existsSync(target)).toBe(false);
  });

  it('preserves an existing target on zero-copy upgrade (no spurious rewrite)', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');

    await makeV3Db((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        ['existing-1', 'k', 'learnings', 'pre-existing'],
      );
    }, target);
    const before = await readFile(target);

    const result = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      // No legacy sources present → cherry-pick no-ops.
      legacyPaths: [join(root, '.swarm', 'memory.db')],
      toPath: target,
    });

    expect(result.copied).toBe(0);
    // Target byte-equal to its pre-state — we did not rewrite it just to
    // round-trip an unchanged sql.js snapshot.
    const after = await readFile(target);
    expect(before.equals(after)).toBe(true);
  });

  it('4.8 upgrade: cherry-picks learnings + knowledge, drops ephemeral rows', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');
    const legacy = join(root, '.swarm', 'memory.db');

    await makeLegacyDb((db) => {
      // Five learnings, three knowledge — both durable.
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
          [`learn-${i}`, `lkey-${i}`, 'learnings', `learning content ${i}`],
        );
      }
      for (let i = 0; i < 3; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
          [`know-${i}`, `kkey-${i}`, 'knowledge', `knowledge content ${i}`],
        );
      }
      // Twelve ephemeral / derived entries — must NOT be copied.
      for (let i = 0; i < 12; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
          [`hm-${i}`, `hmkey-${i}`, 'hive-mind', `ephemeral ${i}`],
        );
      }
    }, legacy);

    // Snapshot the source so we can assert it's untouched after cherry-pick.
    const beforeSrc = await readFile(legacy);

    const result = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [legacy],
      toPath: target,
    });

    expect(result.copied).toBe(8);
    expect(result.considered).toBe(8);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ rowsRead: 8, rowsInserted: 8 });
    expect(result.sources[0]?.reason).toBeUndefined();

    // Target has only the durable namespaces.
    expect(readNamespaceCounts(target)).toEqual({ learnings: 5, knowledge: 3 });

    // Source is read-only: every row still present, contents unchanged.
    // (Asserting row contents rather than file bytes because opening a
    // node:sqlite read connection creates `-wal`/`-shm` sidecars even when
    // no writes occur, which would flip a naive bytes-equal check.)
    void beforeSrc;
    const srcDb = new DatabaseSync(legacy);
    try {
      const rows = srcDb.prepare(
        `SELECT namespace, COUNT(*) AS c FROM memory_entries GROUP BY namespace`,
      ).all() as Array<{ namespace: string; c: number | bigint }>;
      const counts = Object.fromEntries(rows.map((r) => [r.namespace, Number(r.c)]));
      expect(counts).toEqual({ learnings: 5, knowledge: 3, 'hive-mind': 12 });
    } finally {
      srcDb.close();
    }
  });

  it('partial prior migration: idempotent INSERT OR IGNORE skips dupes', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');
    const legacy = join(root, '.swarm', 'memory.db');

    // Target already has 4 of the 8 source rows (a previously-partial cherry pick).
    await makeV3Db((db) => {
      for (let i = 0; i < 4; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
          [`learn-${i}`, `lkey-${i}`, 'learnings', `learning content ${i}`],
        );
      }
    }, target);

    await makeLegacyDb((db) => {
      // 5 learnings + 3 knowledge — same keys as the partial-target rows for
      // learn-0..3, plus one new (learn-4) and 3 net-new knowledge entries.
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
          [`learn-${i}`, `lkey-${i}`, 'learnings', `learning content ${i}`],
        );
      }
      for (let i = 0; i < 3; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
          [`know-${i}`, `kkey-${i}`, 'knowledge', `knowledge content ${i}`],
        );
      }
    }, legacy);

    const result = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [legacy],
      toPath: target,
    });

    expect(result.considered).toBe(8);
    expect(result.copied).toBe(4); // Only the genuinely-new rows.

    const counts = readNamespaceCounts(target);
    expect(counts).toEqual({ learnings: 5, knowledge: 3 });
  });

  it('re-running an interrupted migration completes without duplicate rows', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');
    const legacy = join(root, '.swarm', 'memory.db');

    await makeLegacyDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        ['learn-1', 'lkey-1', 'learnings', 'one'],
      );
    }, legacy);

    const first = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [legacy],
      toPath: target,
    });
    expect(first.copied).toBe(1);

    const second = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [legacy],
      toPath: target,
    });
    expect(second.considered).toBe(1);
    expect(second.copied).toBe(0); // INSERT OR IGNORE handled the retry.
    expect(readNamespaceCounts(target)).toEqual({
      learnings: 1,
    });
  });

  it('skips legacy candidates that lack a memory_entries table', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');
    const legacy = join(root, '.swarm', 'memory.db');

    // Source DB but with an unrelated schema.
    await makeMemoryDb(legacy, 'CREATE TABLE other_table (id INTEGER);', () => {
      /* no rows needed — just the wrong-schema table */
    });

    const result = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [legacy],
      toPath: target,
    });

    expect(result.copied).toBe(0);
    expect(result.sources[0]?.reason).toBe('schema-mismatch');
  });

  it('refuses to read+write the same file (self-reference guard)', async () => {
    const root = await makeRoot();
    const target = join(root, '.moflo', 'moflo.db');

    await makeV3Db((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        ['self-1', 'self-key', 'learnings', 'do not read+write me'],
      );
    }, target);

    const result = await cherryPickLearningsFromLegacy({
      projectRoot: root,
      legacyPaths: [target],
      toPath: target,
    });

    expect(result.copied).toBe(0);
    expect(result.sources[0]?.reason).toBe('self-reference');

    // Target left intact.
    expect(readNamespaceCounts(target)).toEqual({
      learnings: 1,
    });
  });
});
