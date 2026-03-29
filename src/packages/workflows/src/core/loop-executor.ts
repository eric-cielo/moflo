/**
 * Loop Executor
 *
 * Handles loop iteration: executes nested steps for each item in the loop.
 * Extracted from WorkflowRunner (Issue #182).
 */

import type {
  StepOutput,
  WorkflowContext,
} from '../types/step-command.types.js';
import type {
  StepResult,
  WorkflowError,
} from '../types/runner.types.js';
import type { StepDefinition } from '../types/workflow-definition.types.js';

export interface LoopResult {
  success: boolean;
  outputs: Array<Record<string, unknown>>;
}

/**
 * Execute loop iterations — runs nested steps for each item in the loop output.
 *
 * @param loopStep - The loop step definition (must have .steps)
 * @param loopOutput - The output from executing the loop step command
 * @param variables - Mutable variable map (loop vars are injected/restored)
 * @param errors - Mutable error array for recording iteration failures
 * @param signal - Optional abort signal
 * @param executeStep - Callback to execute a single nested step
 */
export async function executeLoopIterations(
  loopStep: StepDefinition,
  loopOutput: StepOutput,
  variables: Record<string, unknown>,
  errors: WorkflowError[],
  signal: AbortSignal | undefined,
  executeStep: (step: StepDefinition, index: number) => Promise<StepResult & { interpolatedConfig?: Record<string, unknown> }>,
): Promise<LoopResult> {
  const data = loopOutput.data as Record<string, unknown>;
  const items = data.items as unknown[];
  const itemVar = (data.itemVar as string) || 'item';
  const indexVar = (data.indexVar as string) || 'index';
  const nestedSteps = loopStep.steps!;
  const iterationOutputs: Array<Record<string, unknown>> = [];
  let allSucceeded = true;

  // Save pre-existing variables that loop vars might shadow
  const hadItem = itemVar in variables;
  const prevItem = variables[itemVar];
  const hadIndex = indexVar in variables;
  const prevIndex = variables[indexVar];

  for (let idx = 0; idx < items.length; idx++) {
    if (signal?.aborted) break;

    variables[itemVar] = items[idx];
    variables[indexVar] = idx;

    const iterOutput: Record<string, unknown> = {};
    let iterFailed = false;

    for (let s = 0; s < nestedSteps.length; s++) {
      if (signal?.aborted) break;

      const nested = nestedSteps[s];
      const result = await executeStep(nested, s);

      if (result.status === 'succeeded' && result.output) {
        if (nested.output) {
          variables[nested.output] = result.output.data;
        }
        variables[nested.id] = result.output.data;
        iterOutput[nested.id] = result.output.data;
      }

      if (result.status === 'failed') {
        errors.push({
          stepId: nested.id,
          code: result.errorCode ?? 'STEP_EXECUTION_FAILED',
          message: `Loop "${loopStep.id}" iteration ${idx}, step "${nested.id}": ${result.error ?? 'failed'}`,
        });
        iterFailed = true;
        allSucceeded = false;
        break;
      }
    }

    iterationOutputs.push(iterOutput);

    if (iterFailed && !loopStep.continueOnError) {
      break;
    }
  }

  // Restore previous values or clean up loop variables
  if (hadItem) variables[itemVar] = prevItem;
  else delete variables[itemVar];
  if (hadIndex) variables[indexVar] = prevIndex;
  else delete variables[indexVar];

  return { success: allSucceeded, outputs: iterationOutputs };
}
