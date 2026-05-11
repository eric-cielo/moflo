/**
 * Tests for the #639 doctor stale-vector-stats check. The check fires when
 * `.moflo/vector-stats.json` has been clobbered with a wrong count (most often
 * `vectorCount: 0`) but the live `.swarm/memory.db` actually has thousands of
 * embedded rows — the case that produced `Vectors ●0` on the statusline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkEmbeddings } from '../../commands/doctor.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-stale-stats-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function seedDb(rowsWithEmbedding: number): void {
  const swarmDir = join(tmpDir, '.swarm');
  mkdirSync(swarmDir, { recursive: true });
  const db = openDaemonDatabase(join(swarmDir, 'memory.db'));
  db.run(MEMORY_SCHEMA_V3);
  for (let i = 0; i < rowsWithEmbedding; i++) {
    db.run(
      `INSERT INTO memory_entries (id, key, content, embedding, embedding_dimensions, embedding_model, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [`row-${i}`, `key-${i}`, `content ${i}`, JSON.stringify([0.1, 0.2]), 2, 'fast-all-MiniLM-L6-v2'],
    );
  }
  db.close();
}

function writeStatsCache(stats: Record<string, unknown>): void {
  const moflo = join(tmpDir, '.moflo');
  mkdirSync(moflo, { recursive: true });
  writeFileSync(join(moflo, 'vector-stats.json'), JSON.stringify(stats));
}

describe('doctor checkEmbeddings — stale vector-stats detection (#639)', () => {
  it('warns when the cached vectorCount is 0 but the DB has many embedded rows', async () => {
    seedDb(50); // DB has 50 embedded rows
    writeStatsCache({ vectorCount: 0, missing: 0, dbSizeKB: 100, namespaces: 1, hasHnsw: false });

    const result = await checkEmbeddings();
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/stale/i);
    expect(result.message).toContain('50');
    expect(result.fix).toBeDefined();
  });

  it('warns when cached vectorCount is far below the actual DB count', async () => {
    seedDb(100);
    // Cache says 10, DB has 100 → 90% skew, well above the 20% threshold
    writeStatsCache({ vectorCount: 10, missing: 0, dbSizeKB: 200, namespaces: 1, hasHnsw: false });

    const result = await checkEmbeddings();
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/stale/i);
  });

  it('passes when cached vectorCount matches DB count exactly', async () => {
    seedDb(20);
    writeStatsCache({ vectorCount: 20, missing: 0, dbSizeKB: 80, namespaces: 1, hasHnsw: false });

    const result = await checkEmbeddings();
    expect(result.status).toBe('pass');
  });

  it('passes when cached count is within the 20% tolerance window', async () => {
    seedDb(100);
    // Cache says 90, DB has 100 → 10% skew, below threshold
    writeStatsCache({ vectorCount: 90, missing: 0, dbSizeKB: 200, namespaces: 1, hasHnsw: false });

    const result = await checkEmbeddings();
    expect(result.status).toBe('pass');
  });
});
