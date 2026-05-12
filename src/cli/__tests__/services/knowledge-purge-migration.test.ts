/**
 * Unit tests for the `knowledge-purge` migration (story #750).
 *
 * Drives `bin/migrations/knowledge-purge.mjs` against fixture sql.js DBs
 * to verify:
 *   - manifest gate (defers when `knowledge-to-learnings` hasn't run)
 *   - hard-deletes active+archived knowledge rows whose `migratedFrom:knowledge`
 *     counterpart exists in `learnings`
 *   - skips orphans with a stderr warning
 *   - is idempotent on a second pass
 *
 * Co-tests `knowledge-to-learnings` because the two migrations form one
 * pipeline — verifying purge alone is brittle without the upstream copy.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as knowledgeToLearningsRun, name as knowledgeToLearningsName }
  from '../../../../bin/migrations/knowledge-to-learnings.mjs';
import { markMigrationDone } from '../../../../bin/lib/migrations.mjs';
import { MIGRATED_FROM_KNOWLEDGE } from '../../../../bin/migrations/lib/markers.mjs';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../../memory/daemon-backend.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal — Windows occasionally holds file handles */
    }
  }
});

interface SeedRow {
  id: string;
  key: string;
  namespace: string;
  content: string;
  status: 'active' | 'archived' | 'deleted';
  tags?: string[];
  embedding?: string;
}

async function makeProject(rows: SeedRow[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-knowledge-purge-'));
  tmpDirs.push(dir);
  await mkdir(join(dir, '.moflo'), { recursive: true });

  const dbPath = join(dir, '.moflo', 'moflo.db');
  const db = openDaemonDatabase(dbPath);
  // Production schema — drift here is caught loud rather than silently
  // letting the migration pass against a stale fixture.
  db.run(MEMORY_SCHEMA_V3);
  for (const r of rows) {
    db.run(
      `INSERT INTO memory_entries (id, key, namespace, content, status, tags, embedding, embedding_dimensions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.key,
        r.namespace,
        r.content,
        r.status,
        JSON.stringify(r.tags ?? []),
        r.embedding ?? null,
        r.embedding ? 384 : null,
      ],
    );
  }
  db.close();
  return dir;
}

function readDb(dir: string): SqlJsLikeDatabase {
  return openDaemonDatabase(join(dir, '.moflo', 'moflo.db'));
}

function rowsByNamespaceStatus(dir: string): Record<string, number> {
  const db = readDb(dir);
  const res = db.exec(
    `SELECT namespace, status, COUNT(*) FROM memory_entries GROUP BY namespace, status`,
  );
  const out: Record<string, number> = {};
  for (const row of res[0]?.values ?? []) out[`${row[0]}/${row[1]}`] = Number(row[2]);
  db.close();
  return out;
}

// Importing knowledge-purge.mjs via a `new URL(...)` so the ESM resolver
// resolves it relative to this file regardless of cwd. Module is cached
// after first import — the gate logic reads the manifest fresh each call,
// so the cache is invariant-safe across tests.
async function importPurge() {
  return await import(new URL('../../../../bin/migrations/knowledge-purge.mjs', import.meta.url).href);
}

describe('knowledge-purge migration', () => {
  it('throws when knowledge-to-learnings has not yet completed (manifest gate)', async () => {
    const dir = await makeProject([
      { id: 'k1', key: 'a', namespace: 'knowledge', content: 'x', status: 'active' },
    ]);

    const purge = await importPurge();
    await expect(purge.run(dir)).rejects.toThrow(/knowledge-to-learnings/);

    const counts = rowsByNamespaceStatus(dir);
    expect(counts['knowledge/active']).toBe(1);
  });

  it('hard-deletes active+archived knowledge rows whose migrated counterpart exists', async () => {
    const seed: SeedRow[] = [];
    for (let i = 0; i < 5; i++) {
      seed.push({
        id: `k-active-${i}`, key: `key-${i}`, namespace: 'knowledge',
        content: `content ${i}`, status: 'active', embedding: '[0.1]',
      });
    }
    for (let i = 0; i < 3; i++) {
      seed.push({
        id: `k-archived-${i}`, key: `archived-${i}`, namespace: 'knowledge',
        content: `archived ${i}`, status: 'archived', embedding: '[0.2]',
      });
    }
    const dir = await makeProject(seed);

    // Run the consolidation copy first — it stamps migratedFrom:knowledge tags
    // on every counterpart.
    const copyResult = await knowledgeToLearningsRun(dir);
    expect(copyResult.rowsMigrated).toBe(8);
    markMigrationDone(dir, knowledgeToLearningsName);

    const purge = await importPurge();
    const result = await purge.run(dir);
    expect(result.purged).toBe(8);
    expect(result.skipped).toBe(0);

    const counts = rowsByNamespaceStatus(dir);
    expect(counts['knowledge/active'] ?? 0).toBe(0);
    expect(counts['knowledge/archived'] ?? 0).toBe(0);
    expect(counts['learnings/active']).toBe(5);
    expect(counts['learnings/archived']).toBe(3);
  });

  it('skips orphan knowledge rows (no migratedFrom:knowledge counterpart)', async () => {
    const dir = await makeProject([
      // Will be purged — has counterpart
      { id: 'k1', key: 'has-counterpart', namespace: 'knowledge', content: 'x', status: 'active' },
      // Truly orphan — has a learnings row but missing the tag
      { id: 'k2', key: 'untagged-counterpart', namespace: 'knowledge', content: 'y', status: 'active' },
      { id: 'l2', key: 'untagged-counterpart', namespace: 'learnings', content: 'y', status: 'active', tags: ['random'] },
      // Truly orphan — no learnings row at all
      { id: 'k3', key: 'no-counterpart', namespace: 'knowledge', content: 'z', status: 'active' },
    ]);

    // Stamp the gate manifest, then add a synthetic counterpart for k1 only.
    const db = readDb(dir);
    db.run(
      `INSERT INTO memory_entries (id, key, namespace, content, status, tags)
       VALUES ('l1', 'has-counterpart', 'learnings', 'x', 'active', ?)`,
      [JSON.stringify([MIGRATED_FROM_KNOWLEDGE, 'source:user', 'locked'])],
    );
    db.close();
    markMigrationDone(dir, knowledgeToLearningsName);

    // Capture stderr so we can verify the orphan-skip warning fires.
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return true;
    });

    let result;
    try {
      const purge = await importPurge();
      result = await purge.run(dir);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(result.purged).toBe(1);
    expect(result.skipped).toBe(2);

    const counts = rowsByNamespaceStatus(dir);
    expect(counts['knowledge/active']).toBe(2); // two orphans survived

    const warnings = stderrChunks.join('').split('\n').filter(l => l.includes('skipping orphan'));
    expect(warnings.length).toBe(2);
    expect(warnings.some(w => w.includes('untagged-counterpart'))).toBe(true);
    expect(warnings.some(w => w.includes('no-counterpart'))).toBe(true);
  });

  it('is idempotent — second invocation reports zero work', async () => {
    const dir = await makeProject([
      { id: 'k1', key: 'a', namespace: 'knowledge', content: 'x', status: 'active' },
      { id: 'k2', key: 'b', namespace: 'knowledge', content: 'y', status: 'archived' },
    ]);
    await knowledgeToLearningsRun(dir);
    markMigrationDone(dir, knowledgeToLearningsName);

    const purge = await importPurge();
    const first = await purge.run(dir);
    expect(first.purged).toBe(2);

    const second = await purge.run(dir);
    expect(second.purged).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it('returns purged:0 when there are no knowledge rows to begin with', async () => {
    const dir = await makeProject([
      { id: 'p1', key: 'unrelated', namespace: 'patterns', content: 'x', status: 'active' },
    ]);
    markMigrationDone(dir, knowledgeToLearningsName);

    const purge = await importPurge();
    const result = await purge.run(dir);
    expect(result.purged).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('handles missing DB file as a clean no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-knowledge-purge-empty-'));
    tmpDirs.push(dir);
    await mkdir(join(dir, '.moflo'), { recursive: true });
    markMigrationDone(dir, knowledgeToLearningsName);

    const purge = await importPurge();
    const result = await purge.run(dir);
    expect(result).toEqual({ purged: 0, skipped: 0 });
  });
});
