/**
 * Epic Execution Order
 *
 * Topological sort using Kahn's algorithm to resolve story dependencies.
 * Detects circular dependencies and groups independent stories.
 *
 * Story #195: Shared epic detection & extraction module.
 */

import type { StoryDefinition, ExecutionPlan } from './types.js';

/**
 * Resolve execution order for stories using Kahn's topological sort.
 *
 * @throws If circular dependencies are detected.
 * @returns Ordered story IDs and independent groups (for potential parallelism).
 */
export function resolveExecutionOrder(stories: StoryDefinition[]): ExecutionPlan {
  const ids = stories.map(s => s.id);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const story of stories) {
    if (story.depends_on) {
      for (const dep of story.depends_on) {
        adjacency.get(dep)?.push(story.id);
        inDegree.set(story.id, (inDegree.get(story.id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(id);
  }

  const order: string[] = [];
  const groups: string[][] = [];

  while (queue.length > 0) {
    const currentLevel = [...queue];
    groups.push(currentLevel);
    queue.length = 0;

    for (const id of currentLevel) {
      order.push(id);
      for (const neighbor of adjacency.get(id) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter(id => !order.includes(id));
    throw new Error(`Circular dependency detected involving: ${remaining.join(', ')}`);
  }

  return { order, independent_groups: groups };
}
