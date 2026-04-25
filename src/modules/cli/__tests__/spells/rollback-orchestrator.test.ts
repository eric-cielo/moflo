/**
 * Rollback Orchestrator Tests
 *
 * Unit tests for rollback logic extracted from SpellCaster (Issue #182).
 */

import { describe, it, expect, vi } from 'vitest';
import { rollbackSteps } from '../../src/spells/core/rollback-orchestrator.js';
import type { CompletedStep } from '../../src/spells/core/rollback-orchestrator.js';
import type { StepResult } from '../../src/spells/types/runner.types.js';
import type { StepCommand, CastingContext } from '../../src/spells/types/step-command.types.js';
import { StepCommandRegistry } from '../../src/spells/core/step-command-registry.js';
import { createMockContext } from './helpers.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCommand(overrides: Partial<StepCommand> = {}): StepCommand {
  return {
    type: 'test',
    description: 'test command',
    configSchema: {},
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: {} }),
    describeOutputs: () => [],
    ...overrides,
  };
}

function makeStepResult(stepId: string, overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepId,
    stepType: 'test',
    status: 'succeeded',
    duration: 10,
    ...overrides,
  };
}

function buildContextFactory(): (index: number) => CastingContext {
  return (index: number) => createMockContext({ stepIndex: index });
}

// ============================================================================
// rollbackSteps
// ============================================================================

describe('rollbackSteps', () => {
  it('should call rollback on completed steps in reverse order', async () => {
    const callOrder: string[] = [];

    const rollbackA = vi.fn(async () => { callOrder.push('a'); });
    const rollbackB = vi.fn(async () => { callOrder.push('b'); });
    const rollbackC = vi.fn(async () => { callOrder.push('c'); });

    const registry = new StepCommandRegistry();
    registry.register(makeCommand({ type: 'typeA', rollback: rollbackA }));
    registry.register(makeCommand({ type: 'typeB', rollback: rollbackB }));
    registry.register(makeCommand({ type: 'typeC', rollback: rollbackC }));

    const completedSteps: CompletedStep[] = [
      { step: { id: 'a', type: 'typeA', config: {} }, config: { cmd: 'a' } },
      { step: { id: 'b', type: 'typeB', config: {} }, config: { cmd: 'b' } },
      { step: { id: 'c', type: 'typeC', config: {} }, config: { cmd: 'c' } },
    ];

    const stepResults: StepResult[] = [
      makeStepResult('a'),
      makeStepResult('b'),
      makeStepResult('c'),
    ];

    await rollbackSteps(completedSteps, registry, buildContextFactory(), stepResults);

    expect(callOrder).toEqual(['c', 'b', 'a']);
    expect(stepResults[0].status).toBe('rolled_back');
    expect(stepResults[1].status).toBe('rolled_back');
    expect(stepResults[2].status).toBe('rolled_back');
  });

  it('should continue rollback even if one step rollback throws', async () => {
    const rollbackOk = vi.fn(async () => {});
    const rollbackFail = vi.fn(async () => { throw new Error('rollback boom'); });

    const registry = new StepCommandRegistry();
    registry.register(makeCommand({ type: 'ok', rollback: rollbackOk }));
    registry.register(makeCommand({ type: 'fail', rollback: rollbackFail }));

    const completedSteps: CompletedStep[] = [
      { step: { id: 'first', type: 'ok', config: {} }, config: {} },
      { step: { id: 'second', type: 'fail', config: {} }, config: {} },
    ];

    const stepResults: StepResult[] = [
      makeStepResult('first'),
      makeStepResult('second'),
    ];

    // Should not throw
    await rollbackSteps(completedSteps, registry, buildContextFactory(), stepResults);

    // The failing step records the error
    expect(stepResults[1].rollbackAttempted).toBe(true);
    expect(stepResults[1].rollbackError).toBe('rollback boom');

    // The other step still rolled back successfully
    expect(stepResults[0].status).toBe('rolled_back');
    expect(stepResults[0].rollbackAttempted).toBe(true);
  });

  it('should skip steps whose commands have no rollback method', async () => {
    const rollbackFn = vi.fn(async () => {});

    const registry = new StepCommandRegistry();
    registry.register(makeCommand({ type: 'with-rollback', rollback: rollbackFn }));
    registry.register(makeCommand({ type: 'no-rollback' })); // no rollback

    const completedSteps: CompletedStep[] = [
      { step: { id: 'a', type: 'with-rollback', config: {} }, config: {} },
      { step: { id: 'b', type: 'no-rollback', config: {} }, config: {} },
    ];

    const stepResults: StepResult[] = [
      makeStepResult('a'),
      makeStepResult('b'),
    ];

    await rollbackSteps(completedSteps, registry, buildContextFactory(), stepResults);

    expect(rollbackFn).toHaveBeenCalledOnce();
    // Step 'b' was skipped — its result should be unchanged
    expect(stepResults[1].status).toBe('succeeded');
    expect(stepResults[1].rollbackAttempted).toBeUndefined();
  });

  it('should return empty when no steps to rollback', async () => {
    const registry = new StepCommandRegistry();
    const stepResults: StepResult[] = [];

    await rollbackSteps([], registry, buildContextFactory(), stepResults);

    expect(stepResults).toEqual([]);
  });

  it('should skip steps with unknown command types', async () => {
    const registry = new StepCommandRegistry();
    // Registry has no commands registered

    const completedSteps: CompletedStep[] = [
      { step: { id: 'x', type: 'unknown', config: {} }, config: {} },
    ];

    const stepResults: StepResult[] = [makeStepResult('x')];

    // Should not throw
    await rollbackSteps(completedSteps, registry, buildContextFactory(), stepResults);

    // Result unchanged — command not found, so rollback skipped
    expect(stepResults[0].status).toBe('succeeded');
  });
});
