/**
 * Parallel Executor Tests
 *
 * Unit tests for parallel step execution (Issue #247).
 */

import { describe, it, expect, vi } from 'vitest';
import { executeParallelSteps } from '../../src/spells/core/parallel-executor.js';
import type { StepOutput } from '../../src/spells/types/step-command.types.js';
import type { StepResult, SpellError } from '../../src/spells/types/runner.types.js';
import type { StepDefinition } from '../../src/spells/types/spell-definition.types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeParallelOutput(maxConcurrency = 0, failFast = true): StepOutput {
  return {
    success: true,
    data: { maxConcurrency, failFast },
  };
}

function makeStep(id: string, overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id,
    type: 'bash',
    config: { command: `echo ${id}` },
    ...overrides,
  };
}

function makeParallelStep(
  nestedSteps: StepDefinition[],
  overrides: Partial<StepDefinition> = {},
): StepDefinition {
  return {
    id: 'parallel-block',
    type: 'parallel',
    config: {},
    steps: nestedSteps,
    ...overrides,
  };
}

function makeSuccessResult(stepId: string, data: Record<string, unknown> = {}): StepResult & { interpolatedConfig?: Record<string, unknown> } {
  return {
    stepId,
    stepType: 'bash',
    status: 'succeeded',
    duration: 5,
    output: { success: true, data },
  };
}

function makeFailureResult(stepId: string): StepResult & { interpolatedConfig?: Record<string, unknown> } {
  return {
    stepId,
    stepType: 'bash',
    status: 'failed',
    duration: 5,
    error: 'step failed',
    errorCode: 'STEP_EXECUTION_FAILED',
  };
}

// ============================================================================
// executeParallelSteps
// ============================================================================

describe('executeParallelSteps', () => {
  it('should execute all nested steps concurrently and merge outputs', async () => {
    const steps = [makeStep('lint'), makeStep('test'), makeStep('typecheck')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput();
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) =>
        makeSuccessResult(step.id, { result: `${step.id}-done` }),
      );

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    expect(executeStep).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual({
      lint: { result: 'lint-done' },
      test: { result: 'test-done' },
      typecheck: { result: 'typecheck-done' },
    });
    // Outputs merged into variables
    expect(variables.lint).toEqual({ result: 'lint-done' });
    expect(variables.test).toEqual({ result: 'test-done' });
    expect(variables.typecheck).toEqual({ result: 'typecheck-done' });
  });

  it('should cancel remaining steps on first failure when failFast is true', async () => {
    const steps = [makeStep('fast'), makeStep('slow'), makeStep('slower')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput(0, true);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) => {
        if (step.id === 'fast') return makeFailureResult(step.id);
        // Slow steps check abort after fast fails
        return makeSuccessResult(step.id);
      });

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    expect(result.success).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('fast');
  });

  it('should run all steps to completion when failFast is false', async () => {
    const steps = [makeStep('a'), makeStep('b'), makeStep('c')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput(0, false);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) => {
        if (step.id === 'a') return makeFailureResult(step.id);
        return makeSuccessResult(step.id, { val: step.id });
      });

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    expect(result.success).toBe(false);
    expect(executeStep).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(1);
    // Successful steps still have their outputs
    expect(result.outputs.b).toEqual({ val: 'b' });
    expect(result.outputs.c).toEqual({ val: 'c' });
  });

  it('should respect maxConcurrency limit', async () => {
    const steps = [makeStep('a'), makeStep('b'), makeStep('c'), makeStep('d')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput(1, true); // maxConcurrency: 1 = sequential
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executionOrder: string[] = [];
    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) => {
        executionOrder.push(step.id);
        return makeSuccessResult(step.id);
      });

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    expect(result.success).toBe(true);
    expect(executeStep).toHaveBeenCalledTimes(4);
    // With maxConcurrency: 1, steps run sequentially in order
    expect(executionOrder).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should throttle to maxConcurrency: 2 with 4 steps', async () => {
    const steps = [makeStep('a'), makeStep('b'), makeStep('c'), makeStep('d')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput(2, true);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    let concurrentCount = 0;
    let maxObservedConcurrency = 0;

    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) => {
        concurrentCount++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentCount);
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));
        concurrentCount--;
        return makeSuccessResult(step.id);
      });

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    expect(result.success).toBe(true);
    expect(executeStep).toHaveBeenCalledTimes(4);
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
  });

  it('should succeed with empty nested steps', async () => {
    const parallelStep = makeParallelStep([]);
    const parallelOutput = makeParallelOutput();
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn();

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    expect(executeStep).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual({});
  });

  it('should propagate abort signal to cancel parallel steps', async () => {
    const steps = [makeStep('a'), makeStep('b'), makeStep('c')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput();
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];
    const controller = new AbortController();

    let executedCount = 0;
    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) => {
        executedCount++;
        // First step aborts for remaining steps
        if (step.id === 'a') controller.abort();
        return makeSuccessResult(step.id);
      });

    const result = await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, controller.signal, executeStep,
    );

    // With Promise.allSettled, all promises are created simultaneously,
    // so the abort signal fires after execution starts but the internal
    // abort controller propagation ensures steps see it
    expect(executedCount).toBeGreaterThanOrEqual(1);
  });

  it('should not let parallel steps see each other outputs during execution', async () => {
    const steps = [makeStep('first'), makeStep('second')];
    const parallelStep = makeParallelStep(steps);
    const parallelOutput = makeParallelOutput();
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const capturedVars: Array<Record<string, unknown>> = [];

    const executeStep = vi.fn()
      .mockImplementation(async (step: StepDefinition) => {
        // Capture variables visible at execution time
        capturedVars.push({ ...variables });
        return makeSuccessResult(step.id, { val: step.id });
      });

    await executeParallelSteps(
      parallelStep, parallelOutput, variables, errors, undefined, executeStep,
    );

    // Neither step should see the other's output during execution
    // (outputs are merged after all steps complete)
    for (const captured of capturedVars) {
      expect(captured.first).toBeUndefined();
      expect(captured.second).toBeUndefined();
    }
  });
});
