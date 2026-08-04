/**
 * memory_cleanup safety invariants (#1349)
 *
 * Both properties here are data-loss-class and were caught in review rather
 * than by a test, which is exactly why they get one:
 *
 *  1. Counting candidates must not delete. The first shape of this handler
 *     deleted on the same call that produced the counts, so the CLI's
 *     "Delete N entries?" prompt was asked *after* the rows were gone and
 *     answering "no" printed "Cleanup cancelled" over a completed deletion.
 *
 *  2. The unusable-entry rule must require an explicit age cutoff. It keys on
 *     `embedding IS NULL`, which means "the embedding model did not run" —
 *     on a project where the model never loaded that is every row, so without
 *     the cutoff a bare `flo memory cleanup` selected the whole store.
 *
 * @module v3/cli/__tests__/mcp-tools/memory-admin-safety
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryAdminTools } from '../../mcp-tools/memory-admin-tools.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/schema.js';

const cleanup = memoryAdminTools.find(t => t.name === 'memory_cleanup')!;

/** Rule #1: os.tmpdir()/path.join only — never a hardcoded /tmp. */
let root: string;
let originalCwd: string;

function activeRows(): number {
  const db = new DatabaseSync(memoryDbPath(root));
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM memory_entries WHERE status = 'active'")
      .get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function seed(rows: Array<{ key: string; expiresAt?: number; embedding?: string }>): void {
  const db = new DatabaseSync(memoryDbPath(root));
  try {
    db.exec(MEMORY_SCHEMA_V3);
    const now = Date.now();
    for (const [i, r] of rows.entries()) {
      db.prepare(
        `INSERT INTO memory_entries
           (id, key, namespace, content, embedding, created_at, updated_at, expires_at, access_count, status)
         VALUES (?, ?, 'default', 'content', ?, ?, ?, ?, 0, 'active')`
      ).run(`e${i}`, r.key, r.embedding ?? null, now, now, r.expiresAt ?? null);
    }
  } finally {
    db.close();
  }
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'moflo-cleanup-'));
  mkdirSync(join(root, '.moflo'), { recursive: true });
  process.chdir(root);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe('memory_cleanup safety (#1349)', () => {
  it('counting candidates does not delete anything', async () => {
    seed([{ key: 'expired', expiresAt: Date.now() - 60_000 }, { key: 'live' }]);
    expect(activeRows()).toBe(2);

    const result = await cleanup.handler({}) as {
      dryRun: boolean;
      candidates: { expired: number; total: number };
    };

    expect(result.dryRun).toBe(true);
    expect(result.candidates.expired).toBe(1);
    // The whole point: it found the candidate and left it alone.
    expect(activeRows()).toBe(2);
  });

  it('deletes only when apply is explicitly requested', async () => {
    seed([{ key: 'expired', expiresAt: Date.now() - 60_000 }, { key: 'live' }]);

    const result = await cleanup.handler({ apply: true }) as {
      dryRun: boolean;
      deleted: { entries: number };
    };

    expect(result.dryRun).toBe(false);
    expect(result.deleted.entries).toBe(1);
    expect(activeRows()).toBe(1);
  });

  it('does not target embedding-less entries without an explicit age cutoff', async () => {
    // Every row has a NULL embedding — the state of any project whose
    // embedding model never loaded.
    seed([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);

    const result = await cleanup.handler({}) as {
      candidates: { lowQuality: number; total: number };
    };

    expect(result.candidates.lowQuality).toBe(0);
    expect(result.candidates.total).toBe(0);
    expect(activeRows()).toBe(3);
  });

  it('targets embedding-less entries once an age cutoff is given', async () => {
    seed([{ key: 'a' }, { key: 'b' }]);

    const result = await cleanup.handler({ olderThan: '0s' }) as {
      candidates: { lowQuality: number };
    };

    expect(result.candidates.lowQuality).toBe(2);
    // Still a count-only call, so nothing is gone yet.
    expect(activeRows()).toBe(2);
  });

  it('leaves entries that still have an embedding alone', async () => {
    seed([
      { key: 'vectorized', embedding: JSON.stringify([0.1, 0.2]) },
      { key: 'bare' },
    ]);

    const result = await cleanup.handler({ olderThan: '0s' }) as {
      candidates: { lowQuality: number };
    };

    expect(result.candidates.lowQuality).toBe(1);
  });
});
