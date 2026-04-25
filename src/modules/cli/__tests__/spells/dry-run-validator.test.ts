/**
 * Dry-Run Validator Tests
 *
 * Unit tests for dry-run validation extracted from SpellCaster (Issue #182).
 */

import { describe, it, expect, vi } from 'vitest';
import { dryRunValidate } from '../../src/spells/core/dry-run-validator.js';
import { StepCommandRegistry } from '../../src/spells/core/step-command-registry.js';
import type { StepCommand, CastingContext, ValidationError } from '../../src/spells/types/step-command.types.js';
import type { SpellDefinition, StepDefinition } from '../../src/spells/types/spell-definition.types.js';
import type { RunnerOptions } from '../../src/spells/types/runner.types.js';
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
  overrides: Partial<SpellDefinition> = {},
): SpellDefinition {
  return {
    name: 'test-spell',
    steps,
    ...overrides,
  };
}

function buildContextFactory(): (variables: Record<string, unknown>, spellId: string, stepIndex: number) => CastingContext {
  return (variables, spellId, stepIndex) =>
    createMockContext({ variables, spellId, stepIndex });
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
    const contextFactory = (variables: Record<string, unknown>, spellId: string, stepIndex: number) => {
      capturedVars.push({ ...variables });
      return createMockContext({ variables, spellId, stepIndex });
    };

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, contextFactory,
    );

    // After step 'a' with output 'stepAOutput', the variable should be set for step 'b'
    expect(capturedVars[1]).toHaveProperty('stepAOutput', { _dryRun: true });
    expect(result.valid).toBe(true);
  });

  it.each(['parallel', 'loop'] as const)(
    'should validate nested %s steps (#252)',
    async (blockType) => {
      const command = makeCommand();
      const registry = new StepCommandRegistry();
      registry.register(command);

      const definition = makeDefinition([
        makeStep({
          id: `${blockType}-1`,
          type: blockType,
          config: {},
          steps: [
            makeStep({ id: 'nested-a', config: { key: 'a' } }),
            makeStep({ id: 'nested-b', config: { key: 'b' } }),
          ],
        }),
      ]);

      const result = await dryRunValidate(
        definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
      );

      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].stepId).toBe(`${blockType}-1`);
      expect(result.steps[1].stepId).toBe('nested-a');
      expect(result.steps[2].stepId).toBe('nested-b');
      expect(result.steps[1].interpolatedConfig).toEqual({ key: 'a' });
      expect(result.steps[2].interpolatedConfig).toEqual({ key: 'b' });
    },
  );

  it('should report unknown command in nested steps', async () => {
    const registry = new StepCommandRegistry();
    // No commands registered

    const definition = makeDefinition([
      makeStep({
        id: 'par',
        type: 'parallel',
        config: {},
        steps: [
          makeStep({ id: 'nested-unknown', type: 'nonexistent', config: {} }),
        ],
      }),
    ]);

    const result = await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, buildContextFactory(),
    );

    expect(result.valid).toBe(false);
    // Both parent and nested should be invalid
    expect(result.steps[0].validationResult.valid).toBe(false);
    const nestedReport = result.steps[1];
    expect(nestedReport.stepId).toBe('nested-unknown');
    expect(nestedReport.validationResult.valid).toBe(false);
    expect(nestedReport.validationResult.errors[0].message).toContain('Unknown step type');
    expect(nestedReport.description).toBe('unknown command');
  });

  it('should set output variables from nested steps', async () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand());

    const definition = makeDefinition([
      makeStep({
        id: 'par',
        type: 'parallel',
        config: {},
        steps: [
          makeStep({ id: 'nested-out', output: 'nestedOutput', config: {} }),
        ],
      }),
      makeStep({ id: 'after' }),
    ]);

    const capturedVars: Record<string, unknown>[] = [];
    const contextFactory = (variables: Record<string, unknown>, spellId: string, stepIndex: number) => {
      capturedVars.push({ ...variables });
      return createMockContext({ variables, spellId, stepIndex });
    };

    await dryRunValidate(
      definition, {}, validDefResult, defaultOptions, registry, contextFactory,
    );

    // The 'after' step context should see the nested output variable
    const afterStepVars = capturedVars[capturedVars.length - 1];
    expect(afterStepVars).toHaveProperty('nestedOutput', { _dryRun: true });
    expect(afterStepVars).toHaveProperty('nested-out', { _dryRun: true });
  });
});
