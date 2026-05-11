/**
 * Tests for the #651 doctor embedding-hygiene check. The check is the
 * automatic regression catcher for the three #648 failure modes:
 *  - banned `domain-aware-hash%` rows
 *  - silent-failure marker (`local` + null embedding)
 *  - mixed neural models in the active set
 *
 * Each test seeds a fresh memory.db with one specific failure mode and
 * asserts the check both flags it and lets a clean DB pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { checkEmbeddingHygiene } from '../../commands/doctor-embedding-hygiene.js';
import { CANONICAL_EMBEDDING_MODEL } from '../../embeddings/migration/types.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-hygiene-'));
  // checkEmbeddingHygiene resolves memory.db relative to cwd — isolate.
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* ignore */ }
});

function seedDb(setup: (db: DatabaseSync) => void): void {
  const swarmDir = join(tmpDir, '.swarm');
  mkdirSync(swarmDir, { recursive: true });
  const dbPath = join(swarmDir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(MEMORY_SCHEMA_V3);
    setup(db);
  } finally {
    db.close();
  }
}

function insert(
  db: DatabaseSync,
  id: string,
  model: string | null,
  hasEmbedding: boolean,
): void {
  const embedding = hasEmbedding ? JSON.stringify([0.1, 0.2]) : null;
  if (model === null) {
    db.prepare(
      `INSERT INTO memory_entries (id, key, content, embedding) VALUES (?, ?, ?, ?)`,
    ).run(id, `k-${id}`, `content-${id}`, embedding);
  } else {
    db.prepare(
      `INSERT INTO memory_entries (id, key, content, embedding, embedding_model)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, `k-${id}`, `content-${id}`, embedding, model);
  }
}

describe('checkEmbeddingHygiene (#651)', () => {
  it('passes when no memory database exists', async () => {
    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('No memory database');
  });

  it('passes on a clean DB with all rows on the canonical model', async () => {
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      insert(db, 'b', CANONICAL_EMBEDDING_MODEL, true);
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('pass');
    expect(result.message).toContain(CANONICAL_EMBEDDING_MODEL);
    expect(result.message).toContain('no residue');
  });

  it("warns on banned 'domain-aware-hash%' rows", async () => {
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      insert(db, 'b', 'domain-aware-hash-v1', true);
      insert(db, 'c', 'domain-aware-hash-384', true);
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('banned hash model');
    expect(result.message).toContain('domain-aware-hash-v1=1');
    expect(result.message).toContain('domain-aware-hash-384=1');
    expect(result.fix).toContain('embeddings init');
  });

  it("warns on the silent-failure marker (model='local' + embedding NULL)", async () => {
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      insert(db, 'b', 'local', false);
      insert(db, 'c', 'local', false);
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('warn');
    expect(result.message).toContain("embedding_model='local'");
    expect(result.message).toContain('AND embedding IS NULL');
  });

  it('warns when more than one neural model is present in the active set', async () => {
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      insert(db, 'b', 'Xenova/all-MiniLM-L6-v2', true);
      insert(db, 'c', 'fastembed/all-MiniLM-L6-v2', true);
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('mixed neural models');
    expect(result.message).toContain('Xenova/all-MiniLM-L6-v2');
    expect(result.message).toContain('fastembed/all-MiniLM-L6-v2');
  });

  it('warns on multiple issues simultaneously without crashing', async () => {
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      insert(db, 'b', 'Xenova/all-MiniLM-L6-v2', true);
      insert(db, 'c', 'domain-aware-hash-v1', true);
      insert(db, 'd', 'local', false);
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('banned hash model');
    expect(result.message).toContain("embedding_model='local'");
    expect(result.message).toContain('mixed neural models');
  });

  it('passes (does not warn) when only sentinels are present alongside the canonical model', async () => {
    // 'none' (Story-1 opt-out tag) and 'local'-with-vector are sentinels
    // that should NOT trigger the silent-failure check (the marker is
    // specifically local+null, not local-with-content).
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      insert(db, 'b', 'none', false);
      insert(db, 'c', 'local', true);
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('pass');
  });

  it('ignores archived rows (status != active)', async () => {
    seedDb((db) => {
      insert(db, 'a', CANONICAL_EMBEDDING_MODEL, true);
      // Banned row, but archived — should not trigger warning. (Soft-delete
      // 'deleted' status was retired in #728; 'archived' is the remaining
      // non-active status that hygiene must skip.)
      db.prepare(
        `INSERT INTO memory_entries (id, key, content, embedding, embedding_model, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('banned-archived', 'k-banned', 'c', JSON.stringify([0.1]), 'domain-aware-hash-v1', 'archived');
    });

    const result = await checkEmbeddingHygiene();
    expect(result.status).toBe('pass');
  });
});
