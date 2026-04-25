/**
 * Circular step jump detection.
 *
 * Condition steps (`type: condition`) can branch via `then` / `else` to other
 * step IDs. This module walks that graph with DFS to surface cycles.
 */

import type { ValidationError } from '../../types/step-command.types.js';
import type { StepDefinition } from '../../types/spell-definition.types.js';

/**
 * Detect cycles in condition step jump targets (then/else).
 * Uses DFS with a visiting set to find back-edges.
 */
export function detectCircularJumps(
  steps: readonly StepDefinition[],
  errors: ValidationError[],
): void {
  const edges = new Map<string, Set<string>>();
  const stepIdSet = new Set<string>();

  for (const step of steps) {
    if (!step.id) continue;
    stepIdSet.add(step.id);

    if (step.type === 'condition' && step.config) {
      const targets = new Set<string>();
      const thenTarget = step.config.then;
      const elseTarget = step.config.else;
      if (typeof thenTarget === 'string' && thenTarget.length > 0) {
        targets.add(thenTarget);
      }
      if (typeof elseTarget === 'string' && elseTarget.length > 0) {
        targets.add(elseTarget);
      }
      if (targets.size > 0) {
        edges.set(step.id, targets);
      }
    }
  }

  if (edges.size === 0) return;

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = path.slice(cycleStart).concat(id);
      errors.push({
        path: 'steps',
        message: `circular condition jump detected: ${cycle.join(' → ')}`,
      });
      return;
    }

    visiting.add(id);
    path.push(id);

    const targets = edges.get(id);
    if (targets) {
      for (const target of targets) {
        if (stepIdSet.has(target)) {
          visit(target, path);
        }
      }
    }

    path.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of edges.keys()) {
    visit(id, []);
  }
}
