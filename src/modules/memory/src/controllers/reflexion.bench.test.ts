/**
 * Reflexion recall benchmark — epic #464 Phase C3 acceptance criterion.
 *
 * The ticket requires: "reflexion recall @ k=10 within 15% of agentdb's
 * HNSW on N=1000 fixtures."
 *
 * moflo's impl is pure brute-force cosine so recall against its own
 * ground truth is 1.0 by construction. What this benchmark actually
 * guards against is:
 *   1. End-to-end retrieval correctness: with keyword-unique fixtures,
 *      the targeted reflexion must show up in top-10 (recall@10 ≥ 0.85
 *      — the 15%-below-HNSW threshold).
 *   2. Latency ceiling: 1000 fixtures, p95 per-query under 500ms on
 *      standard hardware. If we regress below this we've slowed down
 *      the consumer hot path.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import { Reflexion } from './reflexion.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('Reflexion benchmark @ N=1000', () => {
  it('recall@10 ≥ 0.85 and p95 latency < 500ms', async () => {
    const db = new SQL.Database();
    const reflexion = new Reflexion(db as any);

    const N = 1000;
    const fixtures: Array<{ id: string; action: string; keyword: string }> = [];

    for (let i = 0; i < N; i++) {
      // Each fixture gets a unique keyword token so we can target it
      // verbatim and measure whether retrieval surfaces the right row.
      const keyword = `uniq${i}token`;
      const action = `operation ${keyword} step ${i}`;
      const outcome = i % 3 === 0 ? 'success' : 'failure';
      const reflection = `context around ${keyword}, try harder next time`;
      const id = await reflexion.addReflection({ action, outcome, reflection });
      fixtures.push({ id, action, keyword });
    }

    expect(reflexion.count()).toBe(N);

    // Run 20 deterministic queries spread across the fixture space.
    const queryCount = 20;
    const step = Math.floor(N / queryCount);
    const queryIndexes = Array.from({ length: queryCount }, (_, i) => i * step);
    const latencies: number[] = [];
    let hits = 0;

    for (const idx of queryIndexes) {
      const target = fixtures[idx];
      const before = performance.now();
      const results = await reflexion.search(target.keyword, 10);
      latencies.push(performance.now() - before);
      if (results.some((r) => r.id === target.id)) hits++;
    }

    const recall = hits / queryCount;
    const p95 = percentile(latencies, 95);

    // Surface numbers on failure for quick diagnosis.
    if (recall < 0.85 || p95 >= 500) {
      console.error(`recall=${recall.toFixed(3)} p95=${p95.toFixed(1)}ms`);
    }

    expect(recall).toBeGreaterThanOrEqual(0.85);
    expect(p95).toBeLessThan(500);
  }, 60_000);
});

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
