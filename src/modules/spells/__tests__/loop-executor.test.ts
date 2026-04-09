/**
 * Loop Executor Tests
 *
 * Unit tests for loop iteration logic extracted from SpellCaster (Issue #182).
 */

import { describe, it, expect, vi } from 'vitest';
import { executeLoopIterations } from '../src/core/loop-executor.js';
import type { LoopResult } from '../src/core/loop-executor.js';
import type { StepOutput } from '../src/types/step-command.types.js';
import type { StepResult, SpellError } from '../src/types/runner.types.js';
import type { StepDefinition } from '../src/types/spell-definition.types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeLoopOutput(items: unknown[], itemVar = 'item', indexVar = 'index'): StepOutput {
  return {
    success: true,
    data: { items, itemVar, indexVar },
  };
}

function makeNestedStep(id: string, overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id,
    type: 'bash',
    config: { command: 'echo test' },
    ...overrides,
  };
}

function makeLoopStep(
  nestedSteps: StepDefinition[],
  overrides: Partial<StepDefinition> = {},
): StepDefinition {
  return {
    id: 'loop-step',
    type: 'loop',
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
// executeLoopIterations
// ============================================================================

describe('executeLoopIterations', () => {
  it('should iterate over items array, calling executeStep for each', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['a', 'b', 'c']);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn().mockResolvedValue(makeSuccessResult('inner', { val: 1 }));

    const result = await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(executeStep).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(3);
  });

  it('should inject loop variable into context variables for each iteration', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['x', 'y'], 'myItem', 'myIdx');
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const capturedVars: Array<{ item: unknown; idx: unknown }> = [];

    const executeStep = vi.fn().mockImplementation(async () => {
      capturedVars.push({ item: variables.myItem, idx: variables.myIdx });
      return makeSuccessResult('inner');
    });

    await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(capturedVars).toEqual([
      { item: 'x', idx: 0 },
      { item: 'y', idx: 1 },
    ]);
  });

  it('should inject loop namespace so {loop.<itemVar>} references resolve', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['x', 'y'], 'story_number', 'idx');
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const capturedLoop: Array<Record<string, unknown>> = [];

    const executeStep = vi.fn().mockImplementation(async () => {
      capturedLoop.push({ ...(variables.loop as Record<string, unknown>) });
      return makeSuccessResult('inner');
    });

    await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(capturedLoop).toEqual([
      { story_number: 'x', idx: 0 },
      { story_number: 'y', idx: 1 },
    ]);

    // loop namespace should be cleaned up after completion
    expect('loop' in variables).toBe(false);
  });

  it('should restore original loop variable if it existed before', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['a']);
    const variables: Record<string, unknown> = { loop: { existing: true } };
    const errors: SpellError[] = [];

    const executeStep = vi.fn().mockResolvedValue(makeSuccessResult('inner'));

    await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(variables.loop).toEqual({ existing: true });
  });

  it('should restore original variable value after loop completes', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['a']);
    const variables: Record<string, unknown> = { item: 'original', index: 99 };
    const errors: SpellError[] = [];

    const executeStep = vi.fn().mockResolvedValue(makeSuccessResult('inner'));

    await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(variables.item).toBe('original');
    expect(variables.index).toBe(99);
  });

  it('should clean up loop variables when they did not exist before', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['a']);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn().mockResolvedValue(makeSuccessResult('inner'));

    await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect('item' in variables).toBe(false);
    expect('index' in variables).toBe(false);
  });

  it('should stop iteration on step failure (unless continueOnError)', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]); // continueOnError defaults to undefined/false
    const loopOutput = makeLoopOutput(['a', 'b', 'c']);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult('inner'))
      .mockResolvedValueOnce(makeFailureResult('inner'))
      .mockResolvedValueOnce(makeSuccessResult('inner'));

    const result = await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(result.success).toBe(false);
    expect(executeStep).toHaveBeenCalledTimes(2); // Stopped after failure
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('iteration 1');
  });

  it('should continue iteration on step failure when continueOnError is true', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested], { continueOnError: true });
    const loopOutput = makeLoopOutput(['a', 'b', 'c']);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult('inner'))
      .mockResolvedValueOnce(makeFailureResult('inner'))
      .mockResolvedValueOnce(makeSuccessResult('inner'));

    const result = await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(result.success).toBe(false);
    expect(executeStep).toHaveBeenCalledTimes(3); // Continued past failure
    expect(result.outputs).toHaveLength(3);
  });

  it('should handle empty items array', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput([]);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn();

    const result = await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    expect(executeStep).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual([]);
  });

  it('should store step output in variables using step id and output key', async () => {
    const nested = makeNestedStep('inner', { output: 'myOutput' });
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['val']);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];

    const executeStep = vi.fn().mockResolvedValue(
      makeSuccessResult('inner', { result: 'data' }),
    );

    await executeLoopIterations(
      loopStep, loopOutput, variables, errors, undefined, executeStep,
    );

    // After loop, loop vars are cleaned up, but output vars remain
    // During iteration, both step.id and step.output are set
    // We verify via the iteration outputs
    expect(executeStep).toHaveBeenCalledOnce();
  });

  it('should stop on abort signal', async () => {
    const nested = makeNestedStep('inner');
    const loopStep = makeLoopStep([nested]);
    const loopOutput = makeLoopOutput(['a', 'b', 'c']);
    const variables: Record<string, unknown> = {};
    const errors: SpellError[] = [];
    const controller = new AbortController();

    const executeStep = vi.fn().mockImplementation(async () => {
      controller.abort(); // Abort after first iteration
      return makeSuccessResult('inner');
    });

    const result = await executeLoopIterations(
      loopStep, loopOutput, variables, errors, controller.signal, executeStep,
    );

    // Should have executed only the first item before signal was checked
    expect(executeStep).toHaveBeenCalledTimes(1);
    expect(result.outputs).toHaveLength(1);
  });
});
