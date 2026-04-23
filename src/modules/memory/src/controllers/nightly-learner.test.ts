import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { HierarchicalMemory } from './hierarchical-memory.js';
import { MemoryConsolidation } from './memory-consolidation.js';
import { Reflexion } from './reflexion.js';
import { Skills } from './skills.js';
import { NightlyLearner } from './nightly-learner.js';
import { deterministicTestEmbedder } from './_test-embedder.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('NightlyLearner', () => {
  let db: Database;
  let hm: HierarchicalMemory;
  let mc: MemoryConsolidation;
  let reflexion: Reflexion;
  let skills: Skills;
  let nightly: NightlyLearner;

  beforeEach(() => {
    db = new SQL.Database();
    hm = new HierarchicalMemory(db as any, { embedder: deterministicTestEmbedder });
    mc = new MemoryConsolidation(hm, { workingTtlMs: 0 });
    reflexion = new Reflexion(db as any, { embedder: deterministicTestEmbedder });
    skills = new Skills(db as any, { embedder: deterministicTestEmbedder });
    nightly = new NightlyLearner({
      memoryConsolidation: mc,
      reflexion,
      skills,
    });
  });

  afterEach(() => {
    nightly.stop();
  });

  it('consolidate runs the full cycle and reports inventory', async () => {
    await hm.store('to-promote', 0.8, 'working');
    await reflexion.addReflection({ action: 'a', outcome: 'b', reflection: 'c' });
    await skills.addSkill({ name: 'demo', description: 'demo' });

    const report = await nightly.consolidate({ sessionId: 's-1' });
    expect(report.sessionId).toBe('s-1');
    expect(report.reflexionsIndexed).toBe(1);
    expect(report.skillsIndexed).toBe(1);
    expect(report.consolidation?.workingPromoted).toBe(1);
  });

  it('consolidate tolerates missing sub-controllers', async () => {
    const empty = new NightlyLearner();
    const report = await empty.consolidate();
    expect(report.consolidation).toBeUndefined();
    expect(report.reflexionsIndexed).toBe(0);
    expect(report.skillsIndexed).toBe(0);
  });

  it('consolidate surfaces consolidation errors via report.consolidation.error', async () => {
    const broken = {
      consolidate: () => { throw new Error('boom'); },
    } as unknown as MemoryConsolidation;
    const nl = new NightlyLearner({ memoryConsolidation: broken });
    const report = await nl.consolidate();
    expect(report.consolidation).toBeDefined();
    expect((report.consolidation as any).error).toMatch(/boom/);
  });

  it('runCycle is an alias for consolidate', async () => {
    const a = await nightly.runCycle();
    const b = await nightly.consolidate();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('start rejects sub-second intervals', () => {
    expect(() => nightly.start(500)).toThrow(/intervalMs/i);
    expect(nightly.isRunning()).toBe(false);
  });

  it('start is idempotent', () => {
    nightly.start(10_000);
    expect(nightly.isRunning()).toBe(true);
    nightly.start(10_000);
    expect(nightly.isRunning()).toBe(true);
    nightly.stop();
    expect(nightly.isRunning()).toBe(false);
  });
});
