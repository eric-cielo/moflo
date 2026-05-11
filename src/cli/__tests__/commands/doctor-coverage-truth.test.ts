/**
 * Tests for the Embedding Coverage Truth doctor check (epic #1054.S5 / #1059).
 *
 * The check refuses to report 100% when `.moflo/vector-stats.json` disagrees
 * with the live DB count — the failure mode that allowed the 4.9.37 cache
 * clobber to keep saying "100% coverage" while the live DB had dropped 1262
 * rows under the daemon-tick clobber.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkEmbeddingCoverageTruth } from '../../commands/doctor-checks-coverage-truth.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';

type SqlJsDb = {
  run(sql: string, params?: unknown[]): void;
  export(): Uint8Array;
  close(): void;
};
type SqlJsStatic = { Database: new (data?: Uint8Array) => SqlJsDb };

let SQL: SqlJsStatic;
let tmpDir: string;

beforeAll(async () => {
  const initSqlJs = (await import('sql.js')).default;
  SQL = (await initSqlJs()) as SqlJsStatic;
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-coverage-truth-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function seedDb(embeddedRows: number, dbDir = '.moflo', dbName = 'moflo.db'): void {
  const db = new SQL.Database();
  db.run(MEMORY_SCHEMA_V3);
  for (let i = 0; i < embeddedRows; i++) {
    db.run(
      `INSERT INTO memory_entries (id, key, content, embedding, embedding_dimensions, embedding_model, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [`row-${i}`, `key-${i}`, `content ${i}`, JSON.stringify([0.1, 0.2]), 2, 'fast-all-MiniLM-L6-v2'],
    );
  }
  const bytes = db.export();
  db.close();
  const dir = join(tmpDir, dbDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, dbName), Buffer.from(bytes));
}

function writeStatsCache(stats: Record<string, unknown>): void {
  const moflo = join(tmpDir, '.moflo');
  mkdirSync(moflo, { recursive: true });
  writeFileSync(join(moflo, 'vector-stats.json'), JSON.stringify(stats));
}

describe('checkEmbeddingCoverageTruth (#1059)', () => {
  it('passes when there is no cache and no DB', async () => {
    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/nothing to reconcile/);
  });

  it('passes when cache matches live DB exactly', async () => {
    seedDb(20);
    writeStatsCache({ vectorCount: 20, missing: 0, dbSizeKB: 80 });
    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('20');
  });

  it('fails when cache is HIGHER than live DB (clobber-after-cache pattern)', async () => {
    // Repro of #1054 failure mode: build-embeddings wrote 100 to cache, then
    // daemon-tick clobbered the live count back down to 50. Pre-1059 the
    // 20% tolerance hid this; coverage-truth must surface it.
    seedDb(50);
    writeStatsCache({ vectorCount: 100, missing: 0, dbSizeKB: 200 });

    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('cache=100');
    expect(result.message).toContain('live=50');
    expect(result.message).toContain('50'); // lower value
    expect(result.fix).toBeDefined();
  });

  it('fails on even a 1-row disagreement (refuses 100%)', async () => {
    // The story specifically says "refuses 100%" on disagreement — the
    // existing checkEmbeddings has a 20% tolerance that lets near-truth pass.
    // Coverage-truth must be stricter.
    seedDb(100);
    writeStatsCache({ vectorCount: 99, missing: 0, dbSizeKB: 200 });

    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('cache=99');
    expect(result.message).toContain('live=100');
  });

  it('reports the LOWER number when cache disagrees with live', async () => {
    seedDb(40);
    writeStatsCache({ vectorCount: 200, missing: 0, dbSizeKB: 80 });
    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/reporting.*\b40\b/);
  });

  it('warns when DB has rows but no cache exists', async () => {
    seedDb(10);
    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('10');
    expect(result.fix).toBeDefined();
  });

  it('passes when DB is empty and no cache exists (cold-boot fresh install)', async () => {
    // Fresh consumer install: memory DB initialised, zero rows, no
    // vector-stats.json yet. The check is about coverage drift; empty isn't
    // drift, so this must not warn (smoke harness runs in --strict).
    seedDb(0);
    const result = await checkEmbeddingCoverageTruth(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/nothing to reconcile/);
  });
});
