/**
 * Parallel Executor
 *
 * Executes nested steps concurrently with optional concurrency limits
 * and fail-fast semantics. Analogous to loop-executor.ts but for
 * fan-out/fan-in parallelism.
 *
 * Issue #247
 */

import type {
  StepOutput,
} from '../types/step-command.types.js';
import type {
  StepResult,
  WorkflowError,
} from '../types/runner.types.js';
import type { StepDefinition } from '../types/workflow-definition.types.js';

export interface ParallelResult {
  success: boolean;
  outputs: Record<string, unknown>;
}

/**
 * Execute steps in parallel with optional concurrency throttling.
 *
 * @param parallelStep - The parallel step definition (must have .steps)
 * @param parallelOutput - The output from executing the parallel step command
 * @param variables - Mutable variable map (parallel outputs are merged after completion)
 * @param errors - Mutable error array for recording step failures
 * @param signal - Optional abort signal
 * @param executeStep - Callback to execute a single nested step
 */
export async function executeParallelSteps(
  parallelStep: StepDefinition,
  parallelOutput: StepOutput,
  variables: Record<string, unknown>,
  errors: WorkflowError[],
  signal: AbortSignal | undefined,
  executeStep: (step: StepDefinition, index: number) => Promise<StepResult & { interpolatedConfig?: Record<string, unknown> }>,
): Promise<ParallelResult> {
  const data = parallelOutput.data as Record<string, unknown>;
  const maxConcurrency = (data.maxConcurrency as number) || 0;
  const failFast = (data.failFast as boolean) ?? true;
  const nestedSteps = parallelStep.steps!;

  if (nestedSteps.length === 0) {
    return { success: true, outputs: {} };
  }

  const stepOutputs: Record<string, unknown> = {};
  let allSucceeded = true;

  const parallelAbort = new AbortController();
  // Propagate parent abort into the parallel-scoped controller; cleaned up below
  const onParentAbort = () => parallelAbort.abort();
  if (signal) {
    signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const runOne = async (step: StepDefinition, index: number): Promise<StepResult & { interpolatedConfig?: Record<string, unknown> }> => {
    if (parallelAbort.signal.aborted) {
      return {
        stepId: step.id, stepType: step.type, status: 'cancelled', duration: 0,
      };
    }
    const result = await executeStep(step, index);
    if (result.status === 'failed') {
      errors.push({
        stepId: step.id,
        code: result.errorCode ?? 'STEP_EXECUTION_FAILED',
        message: `Parallel "${parallelStep.id}", step "${step.id}": ${result.error ?? 'failed'}`,
      });
      allSucceeded = false;
      if (failFast) {
        parallelAbort.abort();
      }
    }
    if (result.status === 'succeeded' && result.output) {
      stepOutputs[step.id] = result.output.data;
    }
    return result;
  };

  try {
    if (maxConcurrency > 0 && maxConcurrency < nestedSteps.length) {
      await runWithConcurrencyLimit(nestedSteps, maxConcurrency, runOne);
    } else {
      await Promise.allSettled(
        nestedSteps.map((step, idx) => runOne(step, idx)),
      );
    }
  } finally {
    // Prevent listener leak on long-lived parent signals
    if (signal) {
      signal.removeEventListener('abort', onParentAbort);
    }
  }

  for (const [stepId, output] of Object.entries(stepOutputs)) {
    variables[stepId] = output;
  }

  return { success: allSucceeded, outputs: stepOutputs };
}

/**
 * Run tasks with a concurrency limit using a semaphore pattern.
 * Each completed task triggers the next queued task, maintaining
 * at most `limit` concurrent executions.
 */
async function runWithConcurrencyLimit(
  steps: readonly StepDefinition[],
  limit: number,
  runOne: (step: StepDefinition, index: number) => Promise<StepResult & { interpolatedConfig?: Record<string, unknown> }>,
): Promise<void> {
  let nextIndex = 0;
  const results: Array<Promise<void>> = [];

  const runNext = (): Promise<void> | undefined => {
    if (nextIndex >= steps.length) return undefined;
    const idx = nextIndex++;
    const step = steps[idx];
    const p: Promise<void> = runOne(step, idx)
      .catch(() => { /* errors already collected in runOne */ })
      .then((): Promise<void> | void => runNext());
    return p;
  };

  for (let i = 0; i < Math.min(limit, steps.length); i++) {
    const p = runNext();
    if (p) results.push(p);
  }

  await Promise.allSettled(results);
}
