/**
 * CausalRecall — multi-hop walker over CausalGraph.
 *
 * BFS with a visited set bounds the walk to O(V+E); each node is reached
 * via at most one path (shortest-first), ranked by accumulated edge
 * weight. Paths are reconstructed from a parents map so we allocate
 * O(V) instead of an O(V*depth) array-copy per hop.
 */

import { clampInt } from './_shared.js';
import type { CausalEdge, CausalGraph } from './causal-graph.js';

const MAX_DEPTH = 4;
const MAX_PATHS = 50;
const DEFAULT_DEPTH = 2;
const DEFAULT_PATHS = 20;

export interface WalkOptions {
  start: string;
  maxDepth?: number;
  maxPaths?: number;
  relation?: string;
  minWeight?: number;
}

export interface CausalPath {
  nodes: string[];
  edges: CausalEdge[];
  score: number;
  depth: number;
}

export class CausalRecall {
  private graph: CausalGraph;

  constructor(graph: CausalGraph) {
    if (!graph) throw new Error('CausalRecall requires a CausalGraph');
    this.graph = graph;
  }

  async initializeDatabase(): Promise<void> {
    // CausalGraph owns the schema.
  }

  walk(options: WalkOptions): CausalPath[] {
    if (!options?.start) return [];
    const maxDepth = clampInt(options.maxDepth, 1, MAX_DEPTH, DEFAULT_DEPTH);
    const maxPaths = clampInt(options.maxPaths, 1, MAX_PATHS, DEFAULT_PATHS);
    const minWeight = typeof options.minWeight === 'number' ? options.minWeight : 0;

    interface Parent { edge: CausalEdge; depth: number; score: number }
    const parents = new Map<string, Parent>();
    const discovered: string[] = [];
    const visited = new Set<string>([options.start]);
    const queue: Array<{ node: string; depth: number; score: number }> = [
      { node: options.start, depth: 0, score: 1 },
    ];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= maxDepth) continue;
      const neighbors = this.graph.neighbors(cur.node, {
        direction: 'out',
        relation: options.relation,
      });
      for (const edge of neighbors) {
        if (edge.weight < minWeight) continue;
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        const score = cur.score * edge.weight;
        parents.set(edge.target, { edge, depth: cur.depth + 1, score });
        discovered.push(edge.target);
        if (cur.depth + 1 < maxDepth) {
          queue.push({ node: edge.target, depth: cur.depth + 1, score });
        }
      }
    }

    return discovered
      .map((target) => reconstructPath(options.start, target, parents))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPaths);
  }

  shortestPath(
    start: string,
    target: string,
    options: { maxDepth?: number; relation?: string } = {},
  ): CausalPath | null {
    if (!start || !target) return null;
    if (start === target) {
      return { nodes: [start], edges: [], score: 1, depth: 0 };
    }
    const maxDepth = clampInt(options.maxDepth, 1, MAX_DEPTH, MAX_DEPTH);
    const visited = new Set<string>([start]);
    const parents = new Map<string, { edge: CausalEdge; depth: number; score: number }>();
    const queue: Array<{ node: string; depth: number; score: number }> = [
      { node: start, depth: 0, score: 1 },
    ];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= maxDepth) continue;
      const neighbors = this.graph.neighbors(cur.node, {
        direction: 'out',
        relation: options.relation,
      });
      for (const edge of neighbors) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        const score = cur.score * edge.weight;
        parents.set(edge.target, { edge, depth: cur.depth + 1, score });
        if (edge.target === target) {
          return reconstructPath(start, target, parents);
        }
        queue.push({ node: edge.target, depth: cur.depth + 1, score });
      }
    }
    return null;
  }
}

function reconstructPath(
  start: string,
  target: string,
  parents: Map<string, { edge: CausalEdge; depth: number; score: number }>,
): CausalPath {
  const terminal = parents.get(target);
  const score = terminal?.score ?? (target === start ? 1 : 0);
  const edges: CausalEdge[] = [];
  const nodes: string[] = [target];
  let cursor = target;
  while (cursor !== start) {
    const parent = parents.get(cursor);
    if (!parent) break;
    edges.unshift(parent.edge);
    nodes.unshift(parent.edge.source);
    cursor = parent.edge.source;
  }
  return { nodes, edges, score, depth: edges.length };
}

export default CausalRecall;
