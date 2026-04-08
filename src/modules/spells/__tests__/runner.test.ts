/**
 * Workflow Runner Tests
 *
 * Story #104: Tests for sequential workflow executor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpellCaster } from '../src/core/runner.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import type {
  StepCommand,
  CredentialAccessor,
  MemoryAccessor,
} from '../src/types/step-command.types.js';
import type { SpellDefinition } from '../src/types/workflow-definition.types.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockCommand(overrides?: Partial<StepCommand>): StepCommand {
  return {
    type: 'mock',
    description: 'Mock command',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: { result: 'ok' }, duration: 10 }),
    describeOutputs: () => [{ name: 'result', type: 'string' }],
    ...overrides,
  };
}

function createFailingCommand(error = 'Step failed'): StepCommand {
  return createMockCommand({
    type: 'failing',
    execute: async () => ({ success: false, data: {}, error, duration: 5 }),
  });
}

function createMockCredentials(): CredentialAccessor {
  return {
    async get(name: string) { return name === 'secret' ? 's3cr3t' : undefined; },
    async has(name: string) { return name === 'secret'; },
  };
}

function createMockMemory(): MemoryAccessor {
  const store = new Map<string, unknown>();
  return {
    async read(ns: string, key: string) { return store.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) { store.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

function simpleWorkflow(steps: SpellDefinition['steps']): SpellDefinition {
  return { name: 'test-workflow', steps };
}

// ============================================================================
// Setup
// ============================================================================

let registry: StepCommandRegistry;
let runner: SpellCaster;
let memory: MemoryAccessor;

beforeEach(() => {
  registry = new StepCommandRegistry();
  memory = createMockMemory();
  runner = new SpellCaster(registry, createMockCredentials(), memory);
});

// ============================================================================
// Sequential Execution
// ============================================================================

describe('SpellCaster — sequential execution', () => {
  it('should execute a 3-step spell passing outputs forward', async () => {
    let callOrder = 0;

    const step1 = createMockCommand({
      type: 'step1',
      execute: async () => {
        callOrder++;
        return { success: true, data: { value: 'from-step-1', order: callOrder }, duration: 1 };
      },
    });
    const step2 = createMockCommand({
      type: 'step2',
      execute: async (_config, ctx) => {
        callOrder++;
        const prev = ctx.variables['s1'] as Record<string, unknown>;
        return {
          success: true,
          data: { combined: `${prev?.value}-and-step-2`, order: callOrder },
          duration: 1,
        };
      },
    });
    const step3 = createMockCommand({
      type: 'step3',
      execute: async (_config, ctx) => {
        callOrder++;
        const prev = ctx.variables['s2'] as Record<string, unknown>;
        return {
          success: true,
          data: { final: `${prev?.combined}-and-step-3`, order: callOrder },
          duration: 1,
        };
      },
    });

    registry.register(step1);
    registry.register(step2);
    registry.register(step3);

    const definition = simpleWorkflow([
      { id: 's1', type: 'step1', config: {}, output: 's1' },
      { id: 's2', type: 'step2', config: {}, output: 's2' },
      { id: 's3', type: 'step3', config: {}, output: 's3' },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.status === 'succeeded')).toBe(true);
    expect(result.outputs['s3']).toEqual({
      final: 'from-step-1-and-step-2-and-step-3',
      order: 3,
    });
  });

  it('should execute steps in order', async () => {
    const order: string[] = [];

    const cmd = createMockCommand({
      execute: async (_config, ctx) => {
        order.push(`step-${ctx.stepIndex}`);
        return { success: true, data: {}, duration: 1 };
      },
    });
    registry.register(cmd);

    const definition = simpleWorkflow([
      { id: 'a', type: 'mock', config: {} },
      { id: 'b', type: 'mock', config: {} },
      { id: 'c', type: 'mock', config: {} },
    ]);

    await runner.run(definition, {});
    expect(order).toEqual(['step-0', 'step-1', 'step-2']);
  });
});

// ============================================================================
// Error Handling & Rollback
// ============================================================================

describe('SpellCaster — error handling', () => {
  it('should stop on step failure (default behavior)', async () => {
    const rollbackFn = vi.fn();

    registry.register(createMockCommand({ type: 'good', rollback: rollbackFn }));
    registry.register(createFailingCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'good', config: {}, output: 's1' },
      { id: 's2', type: 'failing', config: {} },
      { id: 's3', type: 'good', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].status).toBe('rolled_back');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('skipped');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stepId).toBe('s2');
    expect(rollbackFn).toHaveBeenCalledTimes(1);
  });

  it('should continue when continueOnError is true', async () => {
    registry.register(createMockCommand());
    registry.register(createFailingCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
      { id: 's2', type: 'failing', config: {}, continueOnError: true },
      { id: 's3', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.steps[0].status).toBe('succeeded');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('succeeded');
    expect(result.errors).toHaveLength(1);
  });

  it('should aggregate errors with multiple failures under continueOnError', async () => {
    registry.register(createMockCommand());
    registry.register(createFailingCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'failing', config: {}, continueOnError: true },
      { id: 's2', type: 'failing', config: {}, continueOnError: true },
      { id: 's3', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].stepId).toBe('s1');
    expect(result.errors[1].stepId).toBe('s2');
    expect(result.steps[2].status).toBe('succeeded');
  });

  it('should rollback completed steps in reverse order on failure', async () => {
    const rollbackOrder: string[] = [];

    const makeCmd = (type: string): StepCommand => createMockCommand({
      type,
      rollback: async () => { rollbackOrder.push(type); },
    });

    registry.register(makeCmd('a'));
    registry.register(makeCmd('b'));
    registry.register(createFailingCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'a', config: {}, output: 's1' },
      { id: 's2', type: 'b', config: {}, output: 's2' },
      { id: 's3', type: 'failing', config: {} },
    ]);

    await runner.run(definition, {});
    expect(rollbackOrder).toEqual(['b', 'a']);
  });

  it('should continue rollback if one rollback fails', async () => {
    const rollbackOrder: string[] = [];

    const cmdA = createMockCommand({
      type: 'a',
      rollback: async () => { rollbackOrder.push('a'); },
    });
    const cmdB = createMockCommand({
      type: 'b',
      rollback: async () => { throw new Error('rollback-b failed'); },
    });

    registry.register(cmdA);
    registry.register(cmdB);
    registry.register(createFailingCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'a', config: {}, output: 's1' },
      { id: 's2', type: 'b', config: {}, output: 's2' },
      { id: 's3', type: 'failing', config: {} },
    ]);

    const result = await runner.run(definition, {});

    // Both rollbacks attempted: b first (reverse order), then a
    expect(rollbackOrder).toEqual(['a']); // a succeeded
    const s2Result = result.steps.find(s => s.stepId === 's2');
    expect(s2Result?.rollbackAttempted).toBe(true);
    expect(s2Result?.rollbackError).toContain('rollback-b failed');
  });

  it('should report partial completion', async () => {
    registry.register(createMockCommand());
    registry.register(createFailingCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
      { id: 's2', type: 'mock', config: {} },
      { id: 's3', type: 'failing', config: {} },
      { id: 's4', type: 'mock', config: {} },
      { id: 's5', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    const succeeded = result.steps.filter(s => s.status === 'succeeded').length;
    const failed = result.steps.filter(s => s.status === 'failed').length;
    const skipped = result.steps.filter(s => s.status === 'skipped').length;

    expect(succeeded).toBe(2);
    expect(failed).toBe(1);
    expect(skipped).toBe(2);
  });
});

// ============================================================================
// Argument Validation
// ============================================================================

describe('SpellCaster — argument validation', () => {
  it('should fail before step 1 if required arg is missing', async () => {
    registry.register(createMockCommand());

    const definition: SpellDefinition = {
      name: 'test',
      arguments: {
        name: { type: 'string', required: true },
      },
      steps: [{ id: 's1', type: 'mock', config: {} }],
    };

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(result.errors[0].code).toBe('ARGUMENT_VALIDATION_FAILED');
  });

  it('should resolve default argument values', async () => {
    let receivedArgs: Record<string, unknown> = {};

    registry.register(createMockCommand({
      execute: async (_config, ctx) => {
        receivedArgs = { ...ctx.args };
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition: SpellDefinition = {
      name: 'test',
      arguments: {
        greeting: { type: 'string', default: 'hello' },
      },
      steps: [{ id: 's1', type: 'mock', config: {} }],
    };

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(receivedArgs.greeting).toBe('hello');
  });
});

// ============================================================================
// Timeout
// ============================================================================

describe('SpellCaster — timeout', () => {
  it('should kill step that exceeds timeout', async () => {
    registry.register(createMockCommand({
      execute: () => new Promise((resolve) => {
        setTimeout(() => resolve({ success: true, data: {}, duration: 1000 }), 5000);
      }),
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {}, { defaultStepTimeout: 50 });

    expect(result.success).toBe(false);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].errorCode).toBe('STEP_TIMEOUT');
  });
});

// ============================================================================
// Cancellation
// ============================================================================

describe('SpellCaster — cancellation', () => {
  it('should cancel spell and mark remaining steps as cancelled', async () => {
    const controller = new AbortController();

    registry.register(createMockCommand({
      execute: async () => {
        // Cancel after first step completes
        controller.abort();
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {}, output: 's1' },
      { id: 's2', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {}, { signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.steps.some(s => s.status === 'cancelled')).toBe(true);
    expect(result.errors.some(e => e.code === 'WORKFLOW_CANCELLED')).toBe(true);
  });
});

// ============================================================================
// Credential Masking
// ============================================================================

describe('SpellCaster — credential masking', () => {
  it('should mask credential values in step output', async () => {
    registry.register(createMockCommand({
      execute: async () => ({
        success: true,
        data: { message: 'token is s3cr3t and password is p@ssw0rd' },
        duration: 1,
      }),
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {}, {
      credentialValues: ['s3cr3t', 'p@ssw0rd'],
    });

    expect(result.success).toBe(true);
    const output = result.outputs['s1'] as Record<string, unknown>;
    expect(output.message).not.toContain('s3cr3t');
    expect(output.message).not.toContain('p@ssw0rd');
    expect(output.message).toContain('***REDACTED***');
  });
});

// ============================================================================
// Credential Interpolation ({credentials.NAME})
// ============================================================================

describe('SpellCaster — credential interpolation', () => {
  it('resolves {credentials.NAME} in step config', async () => {
    let capturedConfig: Record<string, unknown> = {};
    registry.register(createMockCommand({
      capabilities: [{ type: 'credentials' }],
      execute: async (config) => {
        capturedConfig = config;
        return { success: true, data: { result: 'ok' }, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: { token: '{credentials.secret}' } },
    ]);

    const result = await runner.run(definition, {});
    expect(result.success).toBe(true);
    expect(capturedConfig.token).toBe('s3cr3t');
  });

  it('redacts credential values resolved from {credentials.NAME}', async () => {
    registry.register(createMockCommand({
      capabilities: [{ type: 'credentials' }],
      execute: async () => ({
        success: true,
        data: { message: 'the secret is s3cr3t' },
        duration: 1,
      }),
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: { token: '{credentials.secret}' } },
    ]);

    const result = await runner.run(definition, {});
    expect(result.success).toBe(true);
    const output = result.outputs['s1'] as Record<string, unknown>;
    expect(output.message).not.toContain('s3cr3t');
    expect(output.message).toContain('***REDACTED***');
  });

  it('leaves {credentials.NAME} unresolved when credential is missing', async () => {
    registry.register(createMockCommand({
      capabilities: [{ type: 'credentials' }],
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: { token: '{credentials.nonexistent}' } },
    ]);

    // Should fail interpolation since credentials.nonexistent is not in variables
    const result = await runner.run(definition, {});
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('Variable not found');
  });

  it('rejects {credentials.*} when command lacks credentials capability', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: { token: '{credentials.secret}' } },
    ]);

    const result = await runner.run(definition, {});
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('does not declare the "credentials" capability');
  });
});

// ============================================================================
// Dry Run
// ============================================================================

describe('SpellCaster — dry run', () => {
  it('should validate without executing', async () => {
    const executeFn = vi.fn().mockResolvedValue({ success: true, data: {}, duration: 1 });

    registry.register(createMockCommand({ execute: executeFn }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
      { id: 's2', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {}, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(0); // No actual step results
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('should report step details in dry run', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: { key: 'value' } },
    ]);

    const dryResult = await runner.dryRun(definition, {});

    expect(dryResult.valid).toBe(true);
    expect(dryResult.steps).toHaveLength(1);
    expect(dryResult.steps[0].stepId).toBe('s1');
    expect(dryResult.steps[0].stepType).toBe('mock');
    expect(dryResult.steps[0].interpolatedConfig).toEqual({ key: 'value' });
    expect(dryResult.steps[0].hasRollback).toBe(false);
  });

  it('should detect unknown step types in dry run', async () => {
    const definition = simpleWorkflow([
      { id: 's1', type: 'nonexistent', config: {} },
    ]);

    const dryResult = await runner.dryRun(definition, {});

    expect(dryResult.valid).toBe(false);
    expect(dryResult.steps[0].validationResult.valid).toBe(false);
  });
});

// ============================================================================
// Definition Validation
// ============================================================================

describe('SpellCaster — definition validation', () => {
  it('should reject invalid definition', async () => {
    const result = await runner.run(
      { name: '', steps: [] } as unknown as SpellDefinition,
      {},
    );

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('DEFINITION_VALIDATION_FAILED');
  });

  it('should reject unknown step types', async () => {
    const definition = simpleWorkflow([
      { id: 's1', type: 'nonexistent', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('DEFINITION_VALIDATION_FAILED');
  });
});

// ============================================================================
// Progress Tracking
// ============================================================================

describe('SpellCaster — progress tracking', () => {
  it('should store progress in memory namespace', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const writeSpy = vi.spyOn(memory, 'write');

    await runner.run(definition, {});

    // Should have been called for initial + after step + completion
    const tasklistWrites = writeSpy.mock.calls.filter(c => c[0] === 'tasklist');
    expect(tasklistWrites.length).toBeGreaterThanOrEqual(2);

    // Final write should show completed
    const lastWrite = tasklistWrites[tasklistWrites.length - 1];
    expect((lastWrite[2] as Record<string, unknown>).status).toBe('completed');
  });

  it('should invoke onStepComplete callback', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
      { id: 's2', type: 'mock', config: {} },
    ]);

    const callback = vi.fn();

    await runner.run(definition, {}, { onStepComplete: callback });

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 's1', status: 'succeeded' }),
      0,
      2,
    );
  });
});

// ============================================================================
// Async Validation
// ============================================================================

describe('SpellCaster — async validation', () => {
  it('should handle async validate that returns a promise', async () => {
    registry.register(createMockCommand({
      validate: async () => {
        await new Promise(r => setTimeout(r, 5));
        return { valid: true, errors: [] };
      },
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Step Validation Failure
// ============================================================================

describe('SpellCaster — step validation failure', () => {
  it('should fail step when validation rejects config', async () => {
    registry.register(createMockCommand({
      validate: () => ({
        valid: false,
        errors: [{ path: 'config.key', message: 'required field missing' }],
      }),
    }));

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].errorCode).toBe('STEP_VALIDATION_FAILED');
  });
});

// ============================================================================
// Variable Interpolation in Runner
// ============================================================================

describe('SpellCaster — variable interpolation', () => {
  it('should interpolate step output references in config', async () => {
    let capturedConfig: Record<string, unknown> = {};

    registry.register(createMockCommand({
      type: 'producer',
      execute: async () => ({
        success: true,
        data: { greeting: 'hello world' },
        duration: 1,
      }),
    }));
    registry.register(createMockCommand({
      type: 'consumer',
      execute: async (config) => {
        capturedConfig = config as Record<string, unknown>;
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      { id: 'produce', type: 'producer', config: {}, output: 'produce' },
      { id: 'consume', type: 'consumer', config: { message: '{produce.greeting}' } },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(capturedConfig.message).toBe('hello world');
  });

  it('should fail step when interpolation references missing variable', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: { ref: '{nonexistent.value}' } },
    ]);

    const result = await runner.run(definition, {});

    // Definition validation will catch this as a forward reference
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Workflow ID
// ============================================================================

describe('SpellCaster — workflowId', () => {
  it('should expose auto-generated workflowId on result', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.workflowId).toBeDefined();
    expect(result.workflowId).toMatch(/^wf-\d+$/);
  });

  it('should use caller-specified workflowId', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {}, { workflowId: 'my-custom-id' });

    expect(result.workflowId).toBe('my-custom-id');
  });

  it('should expose workflowId on failure results', async () => {
    const result = await runner.run(
      { name: '', steps: [] } as unknown as SpellDefinition,
      {},
      { workflowId: 'fail-id' },
    );

    expect(result.workflowId).toBe('fail-id');
  });
});

// ============================================================================
// Callback Safety
// ============================================================================

describe('SpellCaster — callback safety', () => {
  it('should not crash if onStepComplete throws', async () => {
    registry.register(createMockCommand());

    const definition = simpleWorkflow([
      { id: 's1', type: 'mock', config: {} },
      { id: 's2', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {}, {
      onStepComplete: () => { throw new Error('callback exploded'); },
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
  });
});

// ============================================================================
// Condition Branching (Story #136)
// ============================================================================

describe('SpellCaster — condition branching', () => {
  function createConditionCommand(result: boolean, nextStep: string | null): StepCommand {
    return createMockCommand({
      type: 'condition',
      execute: async () => ({
        success: true,
        data: { result, branch: result ? 'then' : 'else', nextStep },
        duration: 1,
      }),
    });
  }

  it('should jump to "then" step when condition is true', async () => {
    registry.register(createConditionCommand(true, 'then-step'));
    registry.register(createMockCommand({ type: 'action' }));

    const definition = simpleWorkflow([
      { id: 'check', type: 'condition', config: {}, output: 'check' },
      { id: 'skipped-step', type: 'action', config: {} },
      { id: 'then-step', type: 'action', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    // Should have executed: check, then-step (skipped-step was jumped over)
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].stepId).toBe('check');
    expect(result.steps[1].stepId).toBe('then-step');
  });

  it('should jump to "else" step when condition is false', async () => {
    registry.register(createConditionCommand(false, 'else-step'));
    registry.register(createMockCommand({ type: 'action' }));

    const definition = simpleWorkflow([
      { id: 'check', type: 'condition', config: {}, output: 'check' },
      { id: 'then-step', type: 'action', config: {} },
      { id: 'else-step', type: 'action', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].stepId).toBe('check');
    expect(result.steps[1].stepId).toBe('else-step');
  });

  it('should fail with CONDITION_TARGET_NOT_FOUND for nonexistent target', async () => {
    registry.register(createConditionCommand(true, 'nonexistent'));
    registry.register(createMockCommand({ type: 'action' }));

    const definition = simpleWorkflow([
      { id: 'check', type: 'condition', config: {} },
      { id: 'action', type: 'action', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('CONDITION_TARGET_NOT_FOUND');
    expect(result.errors[0].message).toContain('nonexistent');
    // Remaining steps should be skipped
    expect(result.steps[1].status).toBe('skipped');
  });

  it('should handle chained conditions (condition → condition → action)', async () => {
    // First condition jumps to second condition, second jumps to final action
    const condA = createMockCommand({
      type: 'cond-a',
      execute: async () => ({
        success: true,
        data: { result: true, branch: 'then', nextStep: 'cond-b' },
        duration: 1,
      }),
    });
    const condB = createMockCommand({
      type: 'cond-b',
      execute: async () => ({
        success: true,
        data: { result: false, branch: 'else', nextStep: 'final' },
        duration: 1,
      }),
    });
    const action = createMockCommand({
      type: 'action',
      execute: async () => ({
        success: true,
        data: { done: true },
        duration: 1,
      }),
    });

    registry.register(condA);
    registry.register(condB);
    registry.register(action);

    const definition = simpleWorkflow([
      { id: 'cond-a', type: 'cond-a', config: {}, output: 'cond-a' },
      { id: 'skipped-1', type: 'action', config: {} },
      { id: 'cond-b', type: 'cond-b', config: {}, output: 'cond-b' },
      { id: 'skipped-2', type: 'action', config: {} },
      { id: 'final', type: 'action', config: {}, output: 'final' },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].stepId).toBe('cond-a');
    expect(result.steps[1].stepId).toBe('cond-b');
    expect(result.steps[2].stepId).toBe('final');
  });

  it('should preserve variable context across jumps', async () => {
    let capturedVars: Record<string, unknown> = {};

    registry.register(createMockCommand({
      type: 'setup',
      execute: async () => ({
        success: true,
        data: { value: 'preserved' },
        duration: 1,
      }),
    }));
    registry.register(createConditionCommand(true, 'consumer'));
    registry.register(createMockCommand({
      type: 'consumer',
      execute: async (_config, ctx) => {
        capturedVars = { ...ctx.variables };
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      { id: 'setup', type: 'setup', config: {}, output: 'setup' },
      { id: 'check', type: 'condition', config: {}, output: 'check' },
      { id: 'skipped', type: 'consumer', config: {} },
      { id: 'consumer', type: 'consumer', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    // Variables from setup step should be available in the jumped-to consumer step
    const setupData = capturedVars['setup'] as Record<string, unknown>;
    expect(setupData?.value).toBe('preserved');
  });

  it('should continue sequentially when nextStep is null', async () => {
    // Condition returns null nextStep — should proceed to next step normally
    registry.register(createConditionCommand(true, null));
    registry.register(createMockCommand({ type: 'action' }));

    const definition = simpleWorkflow([
      { id: 'check', type: 'condition', config: {}, output: 'check' },
      { id: 'next', type: 'action', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].stepId).toBe('check');
    expect(result.steps[1].stepId).toBe('next');
  });
});

// ============================================================================
// Loop Iteration (Story #137)
// ============================================================================

describe('SpellCaster — loop iteration', () => {
  function createLoopCommand(items: unknown[], opts?: { maxIterations?: number; itemVar?: string; indexVar?: string }): StepCommand {
    return createMockCommand({
      type: 'loop',
      execute: async () => {
        const max = opts?.maxIterations ?? 100;
        const actual = Math.min(items.length, max);
        return {
          success: true,
          data: {
            totalItems: items.length,
            iterations: actual,
            truncated: items.length > max,
            itemVar: opts?.itemVar ?? 'item',
            indexVar: opts?.indexVar ?? 'index',
            items: items.slice(0, actual),
          },
          duration: 1,
        };
      },
    });
  }

  it('should iterate over 3 items executing 2 nested steps each', async () => {
    const execLog: string[] = [];

    registry.register(createLoopCommand(['a', 'b', 'c']));
    registry.register(createMockCommand({
      type: 'nested',
      execute: async (_config, ctx) => {
        execLog.push(`${ctx.variables['item']}-${ctx.variables['index']}`);
        return { success: true, data: { processed: ctx.variables['item'] }, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {}, output: 'loop1',
        steps: [
          { id: 'nested-a', type: 'nested', config: {}, output: 'nested-a' },
          { id: 'nested-b', type: 'nested', config: {}, output: 'nested-b' },
        ],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(execLog).toEqual(['a-0', 'a-0', 'b-1', 'b-1', 'c-2', 'c-2']);
    const loopData = result.outputs['loop1'] as Record<string, unknown>;
    expect(loopData.iterationOutputs).toBeDefined();
    const iterOutputs = loopData.iterationOutputs as Array<Record<string, unknown>>;
    expect(iterOutputs).toHaveLength(3);
  });

  it('should respect maxIterations and stop early', async () => {
    const execLog: string[] = [];

    registry.register(createLoopCommand(['a', 'b', 'c', 'd', 'e'], { maxIterations: 2 }));
    registry.register(createMockCommand({
      type: 'nested',
      execute: async (_config, ctx) => {
        execLog.push(String(ctx.variables['item']));
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {}, output: 'loop1',
        steps: [{ id: 'nested', type: 'nested', config: {} }],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(execLog).toEqual(['a', 'b']);
  });

  it('should continue to next iteration with continueOnError', async () => {
    const execLog: string[] = [];

    registry.register(createLoopCommand(['a', 'b', 'c']));
    registry.register(createMockCommand({
      type: 'nested',
      execute: async (_config, ctx) => {
        const item = ctx.variables['item'] as string;
        execLog.push(item);
        if (item === 'b') {
          return { success: false, data: {}, error: 'b failed', duration: 1 };
        }
        return { success: true, data: { processed: item }, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {}, output: 'loop1',
        continueOnError: true,
        steps: [{ id: 'nested', type: 'nested', config: {} }],
      },
    ]);

    const result = await runner.run(definition, {});

    // continueOnError on loop step means failed iterations are skipped
    expect(result.success).toBe(false); // errors were recorded
    expect(execLog).toEqual(['a', 'b', 'c']);
    expect(result.errors.some(e => e.message.includes('iteration 1'))).toBe(true);
  });

  it('should stop loop on nested failure without continueOnError', async () => {
    const execLog: string[] = [];

    registry.register(createLoopCommand(['a', 'b', 'c']));
    registry.register(createMockCommand({
      type: 'nested',
      execute: async (_config, ctx) => {
        const item = ctx.variables['item'] as string;
        execLog.push(item);
        if (item === 'b') {
          return { success: false, data: {}, error: 'b failed', duration: 1 };
        }
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {},
        steps: [{ id: 'nested', type: 'nested', config: {} }],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    expect(execLog).toEqual(['a', 'b']); // stopped at 'b'
  });

  it('should make loop variables accessible in nested step configs via interpolation', async () => {
    let capturedVars: Record<string, unknown> = {};

    registry.register(createLoopCommand(['hello', 'world']));
    registry.register(createMockCommand({
      type: 'nested',
      execute: async (_config, ctx) => {
        capturedVars = { item: ctx.variables['item'], index: ctx.variables['index'] };
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {}, output: 'loop1',
        steps: [{ id: 'nested', type: 'nested', config: {} }],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    // Last iteration should have these values
    expect(capturedVars.item).toBe('world');
    expect(capturedVars.index).toBe(1);
  });

  it('should complete with no iterations for empty items array', async () => {
    registry.register(createLoopCommand([]));
    registry.register(createMockCommand({ type: 'nested' }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {}, output: 'loop1',
        steps: [{ id: 'nested', type: 'nested', config: {} }],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    const loopData = result.outputs['loop1'] as Record<string, unknown>;
    const iterOutputs = loopData.iterationOutputs as unknown[];
    expect(iterOutputs).toHaveLength(0);
  });

  it('should include iteration time in loop step duration', async () => {
    const DELAY_MS = 50;
    registry.register(createLoopCommand(['a', 'b']));
    registry.register(createMockCommand({
      type: 'nested',
      execute: async () => {
        await new Promise(r => setTimeout(r, DELAY_MS));
        return { success: true, data: { done: true }, duration: DELAY_MS };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'loop1', type: 'loop', config: {}, output: 'loop1',
        steps: [{ id: 'nested', type: 'nested', config: {} }],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    const loopStep = result.steps.find(s => s.stepId === 'loop1')!;
    // Duration must include iteration time (~100ms for 2 items x 50ms each)
    expect(loopStep.duration).toBeGreaterThanOrEqual(DELAY_MS * 2 * 0.8);
  });
});

// ============================================================================
// Parallel Step Duration
// ============================================================================

describe('SpellCaster — parallel step duration', () => {
  function createParallelCommand(): StepCommand {
    return createMockCommand({
      type: 'parallel',
      execute: async () => ({
        success: true,
        data: { maxConcurrency: 0, failFast: true },
        duration: 0,
      }),
    });
  }

  it('should include nested step time in parallel step duration', async () => {
    const DELAY_MS = 50;
    registry.register(createParallelCommand());
    registry.register(createMockCommand({
      type: 'nested',
      execute: async () => {
        await new Promise(r => setTimeout(r, DELAY_MS));
        return { success: true, data: { done: true }, duration: DELAY_MS };
      },
    }));

    const definition = simpleWorkflow([
      {
        id: 'par1', type: 'parallel', config: {}, output: 'par1',
        steps: [
          { id: 'a', type: 'nested', config: {} },
          { id: 'b', type: 'nested', config: {} },
        ],
      },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    const parStep = result.steps.find(s => s.stepId === 'par1')!;
    // Parallel steps run concurrently, so duration >= one delay, not zero
    expect(parStep.duration).toBeGreaterThanOrEqual(DELAY_MS * 0.8);
  });
});
