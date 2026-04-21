import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { HierarchicalMemory } from './hierarchical-memory.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('HierarchicalMemory', () => {
  let db: Database;
  let hm: HierarchicalMemory;

  beforeEach(() => {
    db = new SQL.Database();
    hm = new HierarchicalMemory(db as any);
  });

  it('rejects null db', () => {
    expect(() => new HierarchicalMemory(null as any)).toThrow(/requires a sql\.js/i);
  });

  it('store returns ids and increments tier counts', async () => {
    const id = await hm.store('hello world', 0.7, 'working');
    expect(id).toMatch(/^hm-/);
    expect(hm.count('working')).toBe(1);
    expect(hm.count()).toBe(1);
  });

  it('coerces unknown tier names to working', async () => {
    await hm.store('x', 0.5, 'bogus' as any);
    expect(hm.count('working')).toBe(1);
    expect(hm.count('semantic')).toBe(0);
  });

  it('recall surfaces the best match and returns MemoryItem shape', async () => {
    await hm.store('bisect a failing git commit', 0.7, 'working');
    await hm.store('format a date as ISO 8601', 0.5, 'working');
    const hits = await hm.recall({ query: 'find bad commit', k: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toMatch(/bisect/);
    expect(hits[0]).toHaveProperty('score');
    expect((hits[0] as any).embedding).toBeUndefined();
  });

  it('recall honours tier filter', async () => {
    await hm.store('working-item', 0.5, 'working');
    await hm.store('semantic-item', 0.5, 'semantic');
    const working = await hm.recall({ query: 'item', tier: 'working', k: 5 });
    expect(working.every((r) => r.tier === 'working')).toBe(true);
  });

  it('recall bumps accessCount', async () => {
    const id = await hm.store('touched repeatedly', 0.5, 'working');
    await hm.recall({ query: 'touched', k: 1 });
    await hm.recall({ query: 'touched', k: 1 });
    const stmt = db.prepare(`SELECT access_count FROM ${HierarchicalMemory.TABLE} WHERE id = ?`);
    stmt.bind([id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(Number(row.access_count)).toBe(2);
  });

  it('recall supports legacy (string, number) signature', async () => {
    await hm.store('legacy call form', 0.5);
    const hits = await hm.recall('legacy' as any, 3 as any);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('promote moves item between tiers', async () => {
    const id = await hm.store('migratory', 0.5, 'working');
    expect(await hm.promote(id, 'working', 'episodic')).toBe(true);
    expect(hm.count('working')).toBe(0);
    expect(hm.count('episodic')).toBe(1);
  });

  it('forget deletes by id', async () => {
    const id = await hm.store('ephemeral', 0.5, 'working');
    expect(await hm.forget(id)).toBe(true);
    expect(await hm.forget('missing')).toBe(false);
    expect(hm.count()).toBe(0);
  });

  it('getStats returns per-tier counts + total', async () => {
    await hm.store('a', 0.5, 'working');
    await hm.store('b', 0.5, 'episodic');
    await hm.store('c', 0.5, 'semantic');
    const stats = hm.getStats();
    expect(stats.working).toBe(1);
    expect(stats.episodic).toBe(1);
    expect(stats.semantic).toBe(1);
    expect(stats.total).toBe(3);
  });

  it('enforces per-tier capacity', async () => {
    const small = new HierarchicalMemory(new SQL.Database() as any, {
      capacities: { working: 3 } as any,
    });
    for (let i = 0; i < 6; i++) {
      // Importance ascending so the newer, higher-importance items win.
      await small.store(`msg-${i}`, 0.2 + i * 0.1, 'working');
    }
    expect(small.count('working')).toBeLessThanOrEqual(3);
  });

  it('listTier returns oldest first without leaking embeddings', async () => {
    await hm.store('first', 0.5, 'working');
    await new Promise((r) => setTimeout(r, 5));
    await hm.store('second', 0.5, 'working');
    const list = hm.listTier('working');
    expect(list[0].content).toBe('first');
    expect((list[0] as any).embedding).toBeUndefined();
  });
});
