import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { CausalGraph } from './causal-graph.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('CausalGraph', () => {
  let db: Database;
  let graph: CausalGraph;

  beforeEach(() => {
    db = new SQL.Database();
    graph = new CausalGraph(db as any);
  });

  it('rejects null db', () => {
    expect(() => new CausalGraph(null as any)).toThrow(/requires a sql\.js/i);
  });

  it('creates schema idempotently', () => {
    const second = new CausalGraph(db as any);
    expect(second.count()).toBe(0);
  });

  it('addEdge rejects missing source/target/relation', () => {
    expect(() => graph.addEdge('', 'b', { relation: 'r' })).toThrow(/source and target/);
    expect(() => graph.addEdge('a', '', { relation: 'r' })).toThrow(/source and target/);
    expect(() => graph.addEdge('a', 'b', { relation: '' } as any)).toThrow(/relation/);
  });

  it('adds edges and counts them', () => {
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.9 });
    graph.addEdge('b', 'c', { relation: 'caused', weight: 0.7 });
    expect(graph.count()).toBe(2);
  });

  it('dedupes on (source, target, relation)', () => {
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.5 });
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.9 });
    expect(graph.count()).toBe(1);
    const [edge] = graph.edges({ source: 'a' });
    expect(edge.weight).toBeCloseTo(0.9);
  });

  it('neighbors returns direct outgoing edges sorted by weight', () => {
    graph.addEdge('a', 'b', { relation: 'caused', weight: 0.3 });
    graph.addEdge('a', 'c', { relation: 'caused', weight: 0.8 });
    graph.addEdge('a', 'd', { relation: 'preceded', weight: 0.5 });
    const out = graph.neighbors('a');
    expect(out.map((e) => e.target)).toEqual(['c', 'd', 'b']);
  });

  it('neighbors filters by relation', () => {
    graph.addEdge('a', 'b', { relation: 'caused' });
    graph.addEdge('a', 'c', { relation: 'preceded' });
    const caused = graph.neighbors('a', { relation: 'caused' });
    expect(caused).toHaveLength(1);
    expect(caused[0].target).toBe('b');
  });

  it('neighbors supports direction: in', () => {
    graph.addEdge('a', 'x', { relation: 'caused' });
    graph.addEdge('b', 'x', { relation: 'caused' });
    const incoming = graph.neighbors('x', { direction: 'in' });
    expect(incoming.map((e) => e.source).sort()).toEqual(['a', 'b']);
  });

  it('neighbors supports direction: both', () => {
    graph.addEdge('a', 'x', { relation: 'caused' });
    graph.addEdge('x', 'b', { relation: 'caused' });
    const both = graph.neighbors('x', { direction: 'both' });
    expect(both).toHaveLength(2);
  });

  it('clamps weight into [0,1] and defaults timestamp', () => {
    graph.addEdge('a', 'b', { relation: 'r', weight: 5 });
    graph.addEdge('c', 'd', { relation: 'r', weight: -1 });
    const all = graph.edges({});
    const byTarget = Object.fromEntries(all.map((e) => [e.target, e]));
    expect(byTarget.b.weight).toBe(1);
    expect(byTarget.d.weight).toBe(0);
    expect(byTarget.b.timestamp).toBeGreaterThan(0);
  });

  it('clear empties the table', () => {
    graph.addEdge('a', 'b', { relation: 'r' });
    graph.clear();
    expect(graph.count()).toBe(0);
  });

  it('roundtrips metadata JSON', () => {
    graph.addEdge('a', 'b', { relation: 'r', metadata: { note: 'seen' } });
    const [edge] = graph.edges({});
    expect(edge.metadata).toEqual({ note: 'seen' });
  });
});
