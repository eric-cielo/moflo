import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { LearningSystem } from './learning-system.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('LearningSystem', () => {
  let db: Database;
  let ls: LearningSystem;

  beforeEach(() => {
    db = new SQL.Database();
    ls = new LearningSystem(db as any);
  });

  it('rejects null db', () => {
    expect(() => new LearningSystem(null as any)).toThrow(/requires a sql\.js/i);
  });

  it('creates schema idempotently', () => {
    const second = new LearningSystem(db as any);
    expect(second.count()).toBe(0);
  });

  it('recordFeedback persists a row', async () => {
    await ls.recordFeedback({
      taskId: 'build-42',
      success: true,
      quality: 0.9,
      agent: 'coder',
    });
    expect(ls.count()).toBe(1);
  });

  it('record(3-arg) normalizes into recordFeedback', async () => {
    await ls.record('build-42', 0.8, 'success');
    await ls.record('build-42', 0.2, 'failure');
    expect(ls.count()).toBe(2);
    const stats = ls.stats('build');
    expect(stats).toHaveLength(1);
    expect(stats[0].samples).toBe(2);
    expect(stats[0].successes).toBe(1);
    expect(stats[0].failures).toBe(1);
    expect(stats[0].meanQuality).toBeCloseTo(0.5);
  });

  it('groups stats by (task_signature, algorithm)', async () => {
    await ls.recordFeedback({ taskId: 'build-1', success: true, quality: 0.9, algorithm: 'coder' });
    await ls.recordFeedback({ taskId: 'build-2', success: true, quality: 0.7, algorithm: 'coder' });
    await ls.recordFeedback({ taskId: 'build-3', success: true, quality: 0.5, algorithm: 'reviewer' });
    const stats = ls.stats('build');
    const byAlgo = Object.fromEntries(stats.map((s) => [s.algorithm, s]));
    expect(byAlgo.coder.samples).toBe(2);
    expect(byAlgo.coder.meanQuality).toBeCloseTo(0.8);
    expect(byAlgo.reviewer.samples).toBe(1);
  });

  it('recommendAlgorithm returns neutral default on cold start', async () => {
    const rec = await ls.recommendAlgorithm('unknown-task');
    expect(rec.confidence).toBe(0.5);
    expect(rec.samples).toBe(0);
    expect(rec.algorithm).toBeTypeOf('string');
  });

  it('recommendAlgorithm returns highest-quality algorithm for the signature', async () => {
    await ls.recordFeedback({ taskId: 'build-1', success: true, quality: 0.95, algorithm: 'coder' });
    await ls.recordFeedback({ taskId: 'build-2', success: true, quality: 0.95, algorithm: 'coder' });
    await ls.recordFeedback({ taskId: 'build-3', success: false, quality: 0.3, algorithm: 'reviewer' });
    const rec = await ls.recommendAlgorithm('build');
    expect(rec.algorithm).toBe('coder');
    expect(rec.confidence).toBeCloseTo(0.95);
    expect(rec.samples).toBe(3);
  });

  it('recommendAlgorithm is deterministic within a session', async () => {
    await ls.recordFeedback({ taskId: 'route-1', success: true, quality: 0.8, algorithm: 'A' });
    await ls.recordFeedback({ taskId: 'route-2', success: true, quality: 0.6, algorithm: 'B' });
    const first = await ls.recommendAlgorithm('route');
    const second = await ls.recommendAlgorithm('route-x');
    expect(first.algorithm).toBe(second.algorithm);
    expect(first.confidence).toBeCloseTo(second.confidence);
  });

  it('stats(undefined) returns all groups', async () => {
    await ls.recordFeedback({ taskId: 'a-1', success: true, quality: 0.9, algorithm: 'X' });
    await ls.recordFeedback({ taskId: 'b-1', success: true, quality: 0.5, algorithm: 'Y' });
    const all = ls.stats();
    expect(all).toHaveLength(2);
  });

  it('quality is clamped to [0,1]', async () => {
    await ls.recordFeedback({ taskId: 'x-1', success: true, quality: 5, algorithm: 'A' });
    await ls.recordFeedback({ taskId: 'x-2', success: false, quality: -2, algorithm: 'A' });
    const stats = ls.stats('x');
    expect(stats[0].meanQuality).toBeCloseTo(0.5); // (1 + 0) / 2
  });

  it('decay lowers score for older entries', async () => {
    // Two algorithms, same mean quality, different ages.
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await ls.recordFeedback({ taskId: 'p-1', success: true, quality: 0.9, algorithm: 'old', timestamp: weekAgo });
    await ls.recordFeedback({ taskId: 'p-2', success: true, quality: 0.9, algorithm: 'new' });
    const rec = await ls.recommendAlgorithm('p');
    expect(rec.algorithm).toBe('new');
  });
});
