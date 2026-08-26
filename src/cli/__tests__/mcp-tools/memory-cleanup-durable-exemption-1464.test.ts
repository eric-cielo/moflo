/**
 * #1464 — `memory_cleanup` exempts durable namespaces from its AGE-based
 * buckets unless the caller names one explicitly.
 *
 * The defect these pin down: `COALESCE(last_accessed_at, updated_at, created_at)`
 * collapses to `created_at` for any row nothing has ever bumped, and nothing on
 * the search path — the path learnings are actually read through — bumped
 * anything. So the "stale (unused)" bucket meant "old", and the only purge
 * surface moflo ships deleted the most-consulted learnings alongside the dead
 * ones. Age is not evidence of worthlessness for a durable row.
 *
 * The exemption is a DEFAULT, not a prohibition, and it must never reach the
 * TTL bucket — a caller who set an explicit expiry asked for that deletion.
 *
 * @module v3/cli/__tests__/mcp-tools/memory-cleanup-durable-exemption-1464
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryAdminTools } from '../../mcp-tools/memory-admin-tools.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { _resetStateRootCacheForTest } from '../../services/project-root.js';
import { shutdownBridge, _resetProjectRootForTest } from '../../memory/bridge-core.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/schema.js';
import { DURABLE_NAMESPACES } from '../../services/cherry-pick-learnings.js';

const cleanup = memoryAdminTools.find(t => t.name === 'memory_cleanup')!;

type CleanupResult = {
  candidates: { expired: number; stale: number; lowQuality: number; total: number };
  durableHeldBack: number;
  deleted: { entries: number };
};

/** Rule #1: os.tmpdir() + path.join only — never a hardcoded /tmp. */
let root: string;
let originalCwd: string;
let originalProjectDir: string | undefined;

/** Rows are seeded a year old so every age cutoff below catches them. */
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function seed(rows: Array<{ key: string; namespace: string; expiresAt?: number; embedding?: string }>): void {
  const db = new DatabaseSync(memoryDbPath(root));
  try {
    db.exec(MEMORY_SCHEMA_V3);
    const old = Date.now() - YEAR_MS;
    for (const [i, r] of rows.entries()) {
      db.prepare(
        `INSERT INTO memory_entries
           (id, key, namespace, content, embedding, created_at, updated_at, expires_at, access_count, status)
         VALUES (?, ?, ?, 'content', ?, ?, ?, ?, 0, 'active')`
      ).run(`e${i}`, r.key, r.namespace, r.embedding ?? null, old, old, r.expiresAt ?? null);
    }
  } finally {
    db.close();
  }
}

function activeKeys(): string[] {
  const db = new DatabaseSync(memoryDbPath(root));
  try {
    return (db.prepare("SELECT key FROM memory_entries WHERE status = 'active' ORDER BY key")
      .all() as Array<{ key: string }>).map(r => r.key);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  originalCwd = process.cwd();
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

  // realpath both sides (Rule #1 §2): macOS os.tmpdir() is /var/folders/... while
  // resolveStateRoot canonicalizes to /private/var/folders/..., and these
  // assertions must read the same file the handler writes.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1464-cleanup-')));
  mkdirSync(join(root, '.moflo'), { recursive: true });

  // Safety interlock, not boilerplate: resolveStateRoot treats
  // CLAUDE_PROJECT_DIR as authoritative, so without this an `apply: true` case
  // would delete rows from the developer's own .moflo/moflo.db.
  process.env.CLAUDE_PROJECT_DIR = root;
  writeFileSync(memoryDbPath(root), '');
  _resetStateRootCacheForTest();

  process.chdir(root);

  // The bridge registry is module-level and binds to whichever db path first
  // resolved it. Without this teardown the second test's deletes are issued
  // against the FIRST test's temp database — every row reads as missing and
  // `deleted: 0` comes back while the candidate counts (which open the db path
  // directly) look right. Same reason the #1402 harness does it.
  await shutdownBridge();
  _resetProjectRootForTest();
});

afterEach(async () => {
  await shutdownBridge();
  _resetProjectRootForTest();
  process.chdir(originalCwd);
  if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  _resetStateRootCacheForTest();
  rmSync(root, { recursive: true, force: true });
});

describe('memory_cleanup durable exemption (#1464)', () => {
  it('collects no durable rows by age, however old they are', async () => {
    seed([
      { key: 'decision', namespace: 'learnings' },
      { key: 'fact', namespace: 'knowledge' },
    ]);

    const result = await cleanup.handler({ olderThan: '1d' }) as CleanupResult;

    expect(result.candidates.stale).toBe(0);
    expect(result.candidates.lowQuality).toBe(0);
    expect(result.candidates.total).toBe(0);
  });

  it('still collects non-durable rows by age in the same call', async () => {
    seed([
      { key: 'decision', namespace: 'learnings' },
      { key: 'chunk', namespace: 'code-map' },
    ]);

    const result = await cleanup.handler({ olderThan: '1d' }) as CleanupResult;

    // Exactly one candidate, and it is the structural row.
    expect(result.candidates.total).toBe(1);

    const applied = await cleanup.handler({ olderThan: '1d', apply: true }) as CleanupResult;
    expect(applied.deleted.entries).toBe(1);
    expect(activeKeys()).toEqual(['decision']);
  });

  it('reports how many durable rows were held back', async () => {
    seed([
      { key: 'a', namespace: 'learnings' },
      { key: 'b', namespace: 'learnings' },
      { key: 'c', namespace: 'knowledge' },
      { key: 'd', namespace: 'code-map' },
    ]);

    const result = await cleanup.handler({ olderThan: '1d' }) as CleanupResult;

    // A row can match both age buckets; the count is of ROWS withheld, not of
    // bucket matches, so all three durable rows count exactly once each.
    expect(result.durableHeldBack).toBe(3);
  });

  it('counts nothing as held back when there is no durable row to withhold', async () => {
    seed([{ key: 'd', namespace: 'code-map' }]);

    const result = await cleanup.handler({ olderThan: '1d' }) as CleanupResult;

    expect(result.durableHeldBack).toBe(0);
  });

  it('reports no held-back count when no age cutoff was given', async () => {
    // Without `olderThan` the age buckets never run, so there is nothing to
    // withhold and reporting a number would be misleading.
    seed([{ key: 'a', namespace: 'learnings' }]);

    const result = await cleanup.handler({}) as CleanupResult;

    expect(result.candidates.total).toBe(0);
    expect(result.durableHeldBack).toBe(0);
  });

  it('collects durable rows when the caller names the namespace explicitly', async () => {
    seed([
      { key: 'a', namespace: 'learnings' },
      { key: 'b', namespace: 'learnings' },
    ]);

    const result = await cleanup.handler({ olderThan: '1d', namespace: 'learnings' }) as CleanupResult;

    expect(result.candidates.total).toBe(2);
    // The exemption is a default, so naming the namespace also means there is
    // nothing left being withheld.
    expect(result.durableHeldBack).toBe(0);

    const applied = await cleanup.handler({ olderThan: '1d', namespace: 'learnings', apply: true }) as CleanupResult;
    expect(applied.deleted.entries).toBe(2);
    expect(activeKeys()).toEqual([]);
  });

  it('still collects TTL-expired rows in a durable namespace', async () => {
    // A TTL is an explicit instruction from whoever wrote the row. The
    // exemption covers the age heuristic, never an expiry the caller set.
    seed([
      { key: 'ephemeral', namespace: 'learnings', expiresAt: Date.now() - 60_000 },
      { key: 'permanent', namespace: 'learnings' },
    ]);

    const result = await cleanup.handler({ olderThan: '1d' }) as CleanupResult;

    expect(result.candidates.expired).toBe(1);
    expect(result.candidates.stale).toBe(0);

    const applied = await cleanup.handler({ olderThan: '1d', apply: true }) as CleanupResult;
    expect(applied.deleted.entries).toBe(1);
    expect(activeKeys()).toEqual(['permanent']);
  });

  it('does not report a TTL-expired durable row as held back while deleting it', async () => {
    // `lowQualityCond` does not test `expires_at`, so an expired durable row
    // matches it — and would be counted as withheld in the same call that
    // removes it through the expired bucket.
    seed([{ key: 'ephemeral', namespace: 'learnings', expiresAt: Date.now() - 60_000 }]);

    const result = await cleanup.handler({ olderThan: '1d' }) as CleanupResult;

    expect(result.candidates.expired).toBe(1);
    expect(result.durableHeldBack).toBe(0);
  });

  it('exempts every namespace the durable list names', () => {
    // The exemption is generated from DURABLE_NAMESPACES rather than a literal,
    // so a namespace added to that list is covered without touching this file.
    // Pinned so a silent narrowing of the list shows up here.
    expect([...DURABLE_NAMESPACES].sort()).toEqual(['knowledge', 'learnings']);
  });
});
