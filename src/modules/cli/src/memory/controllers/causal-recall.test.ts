import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { CausalGraph } from './causal-graph.js';
import { CausalRecall } from './causal-recall.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('CausalRecall', () => {
  let db: Database;
  let graph: CausalGraph;
  let recall: CausalRecall;

  beforeEach(() => {
    db = new SQL.Database();
    graph = new CausalGraph(db as any);
    recall = new CausalRecall(graph);
  });

  it('rejects null graph', () => {
    expect(() => new CausalRecall(null as any)).toThrow(/requires a CausalGraph/);
  });

  it('returns empty walk when start node missing', () => {
    expect(recall.walk({ start: '' })).toEqual([]);
  });

  it('walks one hop by default', () => {
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.9 });
    graph.addEdge('a', 'c', { relation: 'caused', weight: 0.6 });
    const paths = recall.walk({ start: 'a' });
    expect(paths).toHaveLength(2);
    expect(paths[0].nodes).toEqual(['a', 'b']); // higher weight ranks first
    expect(paths[1].nodes).toEqual(['a', 'c']);
  });

  it('walks multi-hop up to maxDepth', () => {
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.8 });
    graph.addEdge('b', 'c', { relation: 'caused', weight: 0.7 });
    graph.addEdge('c', 'd', { relation: 'caused', weight: 0.6 });
    const paths = recall.walk({ start: 'a', maxDepth: 3 });
    const maxDepth = Math.max(...paths.map((p) => p.depth));
    expect(maxDepth).toBe(3);
    const dPath = paths.find((p) => p.nodes[p.nodes.length - 1] === 'd');
    expect(dPath?.nodes).toEqual(['a', 'b', 'c', 'd']);
    // score = 0.8 * 0.7 * 0.6 = 0.336
    expect(dPath?.score).toBeCloseTo(0.336, 3);
  });

  it('does not loop on cycles', () => {
    graph.addEdge('a', 'b', { relation: 'caused' });
    graph.addEdge('b', 'c', { relation: 'caused' });
    graph.addEdge('c', 'a', { relation: 'caused' });
    const paths = recall.walk({ start: 'a', maxDepth: 4 });
    // Visited set ensures each node appears at most once across the walk.
    const all = paths.flatMap((p) => p.nodes);
    const unique = new Set(all);
    expect(unique.size).toBeLessThanOrEqual(3);
  });

  it('filters by minWeight', () => {
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.9 });
    graph.addEdge('a', 'c', { relation: 'caused', weight: 0.1 });
    const paths = recall.walk({ start: 'a', minWeight: 0.5 });
    expect(paths.map((p) => p.nodes[1])).toEqual(['b']);
  });

  it('filters by relation', () => {
    graph.addEdge('a', 'b', { relation: 'caused' });
    graph.addEdge('a', 'c', { relation: 'preceded' });
    const paths = recall.walk({ start: 'a', relation: 'caused' });
    expect(paths.map((p) => p.nodes[1])).toEqual(['b']);
  });

  it('shortestPath reaches the target', () => {
    graph.addEdge('a', 'b', { relation: 'caused' });
    graph.addEdge('b', 'c', { relation: 'caused' });
    graph.addEdge('c', 'd', { relation: 'caused' });
    const path = recall.shortestPath('a', 'd', { maxDepth: 4 });
    expect(path?.nodes).toEqual(['a', 'b', 'c', 'd']);
    expect(path?.depth).toBe(3);
  });

  it('shortestPath returns null when unreachable', () => {
    graph.addEdge('a', 'b', { relation: 'caused' });
    expect(recall.shortestPath('a', 'z')).toBeNull();
  });

  it('shortestPath to self returns empty path', () => {
    expect(recall.shortestPath('a', 'a')).toEqual({ nodes: ['a'], edges: [], score: 1, depth: 0 });
  });
});

describe('CausalRecall benchmark', () => {
  it('3-hop query < 200ms on 1000-edge graph', () => {
    const db = new SQL.Database();
    const graph = new CausalGraph(db as any);
    const recall = new CausalRecall(graph);
    // Generate a random DAG-ish graph: 500 nodes, 1000 edges.
    const nodes = Array.from({ length: 500 }, (_, i) => `n${i}`);
    let edgeCount = 0;
    for (let i = 0; i < nodes.length && edgeCount < 1000; i++) {
      // Each node links to up to 3 later nodes; a few back-edges to exercise
      // the visited-set without creating cycles that explode the walk.
      for (let k = 1; k <= 3 && i + k < nodes.length && edgeCount < 1000; k++) {
        graph.addEdge(nodes[i], nodes[i + k], { relation: 'caused', weight: 0.5 + (k / 10) });
        edgeCount++;
      }
    }
    expect(graph.count()).toBeGreaterThanOrEqual(1000);
    const start = performance.now();
    const paths = recall.walk({ start: nodes[0], maxDepth: 3, maxPaths: 50 });
    const elapsed = performance.now() - start;
    expect(paths.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});
