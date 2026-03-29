/**
 * Rollback Orchestrator
 *
 * Runs rollback on completed steps in reverse order, handling failures gracefully.
 * Extracted from WorkflowRunner (Issue #182).
 */

import type {
  WorkflowContext,
  StepCommand,
} from '../types/step-command.types.js';
import type {
  StepResult,
} from '../types/runner.types.js';
import type { StepDefinition } from '../types/workflow-definition.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';

export interface CompletedStep {
  step: StepDefinition;
  config: Record<string, unknown>;
}

/**
 * Roll back completed steps in reverse order.
 * Continues rolling back even if individual rollbacks fail.
 */
export async function rollbackSteps(
  completedSteps: CompletedStep[],
  registry: StepCommandRegistry,
  buildContext: (index: number) => WorkflowContext,
  stepResults: StepResult[],
): Promise<void> {
  for (let i = completedSteps.length - 1; i >= 0; i--) {
    const { step, config } = completedSteps[i];
    const command = registry.get(step.type);

    if (!command?.rollback) continue;

    const context = buildContext(i);
    try {
      await command.rollback(config, context);
      const idx = stepResults.findIndex(r => r.stepId === step.id);
      if (idx !== -1) {
        stepResults[idx] = { ...stepResults[idx], status: 'rolled_back', rollbackAttempted: true };
      }
    } catch (err) {
      const idx = stepResults.findIndex(r => r.stepId === step.id);
      if (idx !== -1) {
        stepResults[idx] = {
          ...stepResults[idx],
          rollbackAttempted: true,
          rollbackError: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
}
