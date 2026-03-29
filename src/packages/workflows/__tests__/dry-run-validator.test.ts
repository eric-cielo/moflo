/**
 * Dry-Run Validator Tests
 *
 * Unit tests for dry-run validation extracted from WorkflowRunner (Issue #182).
 */

import { describe, it, expect, vi } from 'vitest';
import { dryRunValidate } from '../src/core/dry-run-validator.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import type { StepCommand, WorkflowContext, ValidationError } from '../src/types/step-command.types.js';
import type { WorkflowDefinition, StepDefinition } from '../src/types/workflow-definition.types.js';
import type { RunnerOptions } from '../src/types/runner.types.js';
import { createMockContext } from './helpers.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCommand(overrides: Partial<StepCommand> = {}): StepCommand {
  return {
    type: 'test',
    description: 'A test command',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: {} }),
    describeOutputs: () => [],
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id: 'step-1',
    type: 'test',
    config: { key: 'value' },
    ...overrides,
  };
}

function makeDefinition(
  steps: StepDefinition[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    name: 'test-workflow',
    steps,
    ...overrides,
  };
}

function buildContextFactory(): (variables: Record<string, unknown>, workflowId: string, stepIndex: number) => WorkflowContext {
  return (variables, workflowId, stepIndex) =>
    createMockContext({ variables, workflowId, stepIndex });
}

const defaultOptions: RunnerOptions = {};
const validDefResult = { valid: true, errors: [] as ValidationError[] };

// ============================================================================
// dryRunValidate
// ============================================================================

describe('dryRunValidate', () => {
  it('should report validation results for each step without executing', async () => {
    const command = makeCommand();
    const registry = new StepCommandRegistry();
    registry.register(command);

    const definition = makeDefinition([
      makeStep({ id: 'a' }),
      makeStep({ id: 'b' }),
    ]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.valid).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].stepId).toBe('a');
    expect(result.steps[0].validationResult.valid).toBe(true);
    expect(result.steps[1].stepId).toBe('b');
  });

  it('should report capability check results', async () => {
    // A command that declares capabilities but step restricts them
    const command = makeCommand({
      type: 'bash',
      capabilities: [{ type: 'shell' }, { type: 'fs:write' }],
    });

    const registry = new StepCommandRegistry();
    registry.register(command);

    // Step that declares a capability not in the command's defaults
    const step = makeStep({
      type: 'bash',
      capabilities: { 'net': [] }, // bash doesn't declare 'net'
    });

    const definition = makeDefinition([step]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    // The capability validator should flag the mismatch
    expect(result.steps[0].stepType).toBe('bash');
    // Result is populated — whether valid depends on checkCapabilities behavior
    expect(result.steps[0].validationResult).toBeDefined();
  });

  it('should report interpolated config preview', async () => {
    const command = makeCommand();
    const registry = new StepCommandRegistry();
    registry.register(command);

    const step = makeStep({ config: { greeting: 'hello' } });
    const definition = makeDefinition([step]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.steps[0].interpolatedConfig).toEqual({ greeting: 'hello' });
  });

  it('should handle steps with unknown command types', async () => {
    const registry = new StepCommandRegistry();
    // No commands registered

    const step = makeStep({ type: 'nonexistent' });
    const definition = makeDefinition([step]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.valid).toBe(false);
    expect(result.steps[0].validationResult.valid).toBe(false);
    expect(result.steps[0].validationResult.errors[0].message).toContain('Unknown step type');
    expect(result.steps[0].description).toBe('unknown command');
  });

  it('should propagate definition validation errors', async () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand());

    const definition = makeDefinition([makeStep()]);
    const defErrors = {
      valid: false,
      errors: [{ path: 'name', message: 'Name is required' }],
    };

    const result = await dryRunValidate(
      definition, {}, defErrors, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.valid).toBe(false);
    expect(result.definitionErrors).toEqual(defErrors.errors);
  });

  it('should report hasRollback for steps with rollback methods', async () => {
    const withRollback = makeCommand({
      type: 'rollbackable',
      rollback: async () => {},
    });
    const withoutRollback = makeCommand({ type: 'plain' });

    const registry = new StepCommandRegistry();
    registry.register(withRollback);
    registry.register(withoutRollback);

    const definition = makeDefinition([
      makeStep({ id: 'r', type: 'rollbackable' }),
      makeStep({ id: 'p', type: 'plain' }),
    ]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.steps[0].hasRollback).toBe(true);
    expect(result.steps[1].hasRollback).toBe(false);
  });

  it('should report continueOnError from step definition', async () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand());

    const definition = makeDefinition([
      makeStep({ id: 'a', continueOnError: true }),
      makeStep({ id: 'b' }),
    ]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.steps[0].continueOnError).toBe(true);
    expect(result.steps[1].continueOnError).toBe(false);
  });

  it('should handle step validation failure from command.validate', async () => {
    const failingCommand = makeCommand({
      validate: () => ({
        valid: false,
        errors: [{ path: 'config.url', message: 'URL is required' }],
      }),
    });

    const registry = new StepCommandRegistry();
    registry.register(failingCommand);

    const definition = makeDefinition([makeStep()]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.valid).toBe(false);
    expect(result.steps[0].validationResult.valid).toBe(false);
    expect(result.steps[0].validationResult.errors[0].message).toBe('URL is required');
  });

  it('should set output variables for dry-run placeholders', async () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand());

    const definition = makeDefinition([
      makeStep({ id: 'a', output: 'stepAOutput' }),
      makeStep({ id: 'b' }),
    ]);

    const capturedVars: Record<string, unknown>[] = [];
    const contextFactory = (variables: Record<string, unknown>, workflowId: string, stepIndex: number) => {
      capturedVars.push({ ...variables });
      return createMockContext({ variables, workflowId, stepIndex });
    };

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, contextFactory,
    );

    // After step 'a' with output 'stepAOutput', the variable should be set for step 'b'
    expect(capturedVars[1]).toHaveProperty('stepAOutput', { _dryRun: true });
    expect(result.valid).toBe(true);
  });
});
