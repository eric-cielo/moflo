import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { HierarchicalMemory } from './hierarchical-memory.js';
import { MemoryConsolidation } from './memory-consolidation.js';
import { deterministicTestEmbedder } from './_test-embedder.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('MemoryConsolidation', () => {
  let db: Database;
  let hm: HierarchicalMemory;
  let mc: MemoryConsolidation;

  beforeEach(() => {
    db = new SQL.Database();
    hm = new HierarchicalMemory(db as any, { embedder: deterministicTestEmbedder });
    // Zero TTLs so the first consolidate() fires all rules deterministically.
    mc = new MemoryConsolidation(hm, {
      workingTtlMs: 0,
      forgetAfterMs: 24 * 60 * 60 * 1000,
      episodicPromoteThreshold: 2,
    });
  });

  it('rejects null HierarchicalMemory', () => {
    expect(() => new MemoryConsolidation(null as any)).toThrow(/requires a HierarchicalMemory/i);
  });

  it('promotes working items past ttl into episodic', async () => {
    await hm.store('promote-me', 0.7, 'working');
    const report = await mc.consolidate();
    expect(report.workingPromoted).toBe(1);
    expect(hm.count('working')).toBe(0);
    expect(hm.count('episodic')).toBe(1);
  });

  it('forgets unaccessed stale working items', async () => {
    // Seed a very old un-accessed working row directly in SQL so we don't
    // wait minutes for real-time staleness.
    const oldTs = Date.now() - 14 * 24 * 60 * 60 * 1000;
    db.run(
      `INSERT INTO ${HierarchicalMemory.TABLE}
         (id, key, tier, content, importance, metadata, tags, embedding, created_at, accessed_at, access_count)
       VALUES (?, ?, 'working', ?, 0.3, '{}', '[]', NULL, ?, ?, 0)`,
      ['stale-1', 'stale-1', 'old and unused', oldTs, oldTs],
    );
    const report = await mc.consolidate();
    expect(report.memoriesForgotten).toBe(1);
    expect(hm.count()).toBe(0);
  });

  it('promotes frequently-recalled episodic items to semantic', async () => {
    const id = await hm.store('recall me', 0.5, 'episodic');
    // Simulate prior recalls by bumping access_count.
    db.run(
      `UPDATE ${HierarchicalMemory.TABLE} SET access_count = 3 WHERE id = ?`,
      [id],
    );
    const report = await mc.consolidate();
    expect(report.semanticCreated).toBe(1);
    expect(hm.count('semantic')).toBe(1);
  });

  it('high-importance episodic items promote on a single access', async () => {
    const id = await hm.store('vital', 0.95, 'episodic');
    db.run(
      `UPDATE ${HierarchicalMemory.TABLE} SET access_count = 1 WHERE id = ?`,
      [id],
    );
    const report = await mc.consolidate();
    expect(report.semanticCreated).toBe(1);
  });

  it('report carries a timestamp', async () => {
    const before = Date.now();
    const report = await mc.consolidate();
    expect(report.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('caps per-run work via maxPerRun', async () => {
    const capped = new MemoryConsolidation(hm, {
      workingTtlMs: 0,
      maxPerRun: 2,
    });
    for (let i = 0; i < 5; i++) {
      await hm.store(`w-${i}`, 0.4, 'working');
    }
    await capped.consolidate();
    // Only 2 should have moved out of working.
    expect(hm.count('working')).toBe(3);
  });
});
