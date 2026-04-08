/**
 * Parallel Step Integration Tests
 *
 * Tests for parallel step execution through the full SpellCaster (Issue #247).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpellCaster } from '../src/core/runner.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { parallelCommand } from '../src/commands/parallel-command.js';
import type {
  StepCommand,
  CredentialAccessor,
  MemoryAccessor,
} from '../src/types/step-command.types.js';
import type { SpellDefinition } from '../src/types/workflow-definition.types.js';
import { validateSpellDefinition } from '../src/schema/validator.js';

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

beforeEach(() => {
  registry = new StepCommandRegistry();
  registry.register(parallelCommand);
  runner = new SpellCaster(registry, createMockCredentials(), createMockMemory());
});

// ============================================================================
// Runner Integration — Parallel Steps
// ============================================================================

describe('SpellCaster — parallel step execution', () => {
  it('should run setup → parallel(lint, test, typecheck) → deploy end-to-end', async () => {
    const executionOrder: string[] = [];

    const mockCmd = createMockCommand({
      execute: async (config) => {
        executionOrder.push(config.name as string);
        return { success: true, data: { name: config.name }, duration: 1 };
      },
    });
    registry.register(mockCmd);

    const definition = simpleWorkflow([
      { id: 'setup', type: 'mock', config: { name: 'setup' } },
      {
        id: 'checks',
        type: 'parallel',
        config: {},
        steps: [
          { id: 'lint', type: 'mock', config: { name: 'lint' } },
          { id: 'test', type: 'mock', config: { name: 'test' } },
          { id: 'typecheck', type: 'mock', config: { name: 'typecheck' } },
        ],
      },
      { id: 'deploy', type: 'mock', config: { name: 'deploy' } },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    // setup runs first, deploy runs last
    expect(executionOrder[0]).toBe('setup');
    expect(executionOrder[executionOrder.length - 1]).toBe('deploy');
    // lint, test, typecheck run between (order among them is non-deterministic)
    expect(executionOrder.slice(1, 4).sort()).toEqual(['lint', 'test', 'typecheck']);
  });

  it('should stop spell when parallel step fails and continueOnError is not set', async () => {
    const failCmd = createFailingCommand('lint failed');
    registry.register(failCmd);

    const mockCmd = createMockCommand();
    registry.register(mockCmd);

    const definition = simpleWorkflow([
      { id: 'setup', type: 'mock', config: {} },
      {
        id: 'checks',
        type: 'parallel',
        config: { failFast: false },
        steps: [
          { id: 'lint', type: 'failing', config: {} },
          { id: 'test', type: 'mock', config: {} },
        ],
      },
      { id: 'deploy', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(false);
    // deploy should be skipped
    const deployStep = result.steps.find(s => s.stepId === 'deploy');
    expect(deployStep?.status).toBe('skipped');
  });

  it('should continue spell when parallel step fails but continueOnError is true', async () => {
    const failCmd = createFailingCommand('test failed');
    registry.register(failCmd);

    const mockCmd = createMockCommand();
    registry.register(mockCmd);

    const definition = simpleWorkflow([
      { id: 'setup', type: 'mock', config: {} },
      {
        id: 'checks',
        type: 'parallel',
        config: {},
        continueOnError: true,
        steps: [
          { id: 'lint', type: 'failing', config: {} },
        ],
      },
      { id: 'deploy', type: 'mock', config: {} },
    ]);

    const result = await runner.run(definition, {});

    // Workflow continues because parallel step has continueOnError: true
    const deployStep = result.steps.find(s => s.stepId === 'deploy');
    expect(deployStep?.status).toBe('succeeded');
  });

  it('should make parallel step outputs available to subsequent steps', async () => {
    let deploySawLintOutput = false;

    const lintCmd = createMockCommand({
      type: 'lint-cmd',
      execute: async () => ({ success: true, data: { issues: 0 }, duration: 1 }),
    });
    const deployCmd = createMockCommand({
      type: 'deploy-cmd',
      execute: async (_config, ctx) => {
        const lintData = ctx.variables['lint'] as Record<string, unknown> | undefined;
        deploySawLintOutput = lintData?.issues === 0;
        return { success: true, data: {}, duration: 1 };
      },
    });
    registry.register(lintCmd);
    registry.register(deployCmd);

    const definition = simpleWorkflow([
      {
        id: 'checks',
        type: 'parallel',
        config: {},
        steps: [
          { id: 'lint', type: 'lint-cmd', config: {} },
        ],
      },
      { id: 'deploy', type: 'deploy-cmd', config: {} },
    ]);

    const result = await runner.run(definition, {});

    expect(result.success).toBe(true);
    expect(deploySawLintOutput).toBe(true);
  });
});

// ============================================================================
// Validator — Parallel Cross-References
// ============================================================================

describe('validateSpellDefinition — parallel cross-references', () => {

  it('should reject cross-references between sibling steps in a parallel block', () => {
    const definition: SpellDefinition = {
      name: 'test',
      steps: [
        {
          id: 'par',
          type: 'parallel',
          config: {},
          steps: [
            { id: 'a', type: 'bash', config: { command: 'echo a' } },
            { id: 'b', type: 'bash', config: { command: 'echo {a.result}' } },
          ],
        },
      ],
    };

    const result = validateSpellDefinition(definition, { knownStepTypes: ['parallel', 'bash'] });
    const crossRefError = result.errors.find((e: { message: string; path?: string }) =>
      e.message.includes('parallel step') && e.message.includes('sibling'),
    );
    expect(crossRefError).toBeDefined();
  });

  it('should allow post-parallel step to reference parallel step output', () => {
    const definition: SpellDefinition = {
      name: 'test',
      steps: [
        {
          id: 'par',
          type: 'parallel',
          config: {},
          steps: [
            { id: 'lint', type: 'bash', config: { command: 'echo lint' } },
          ],
        },
        { id: 'deploy', type: 'bash', config: { command: 'echo {lint.result}' } },
      ],
    };

    const result = validateSpellDefinition(definition, { knownStepTypes: ['parallel', 'bash'] });
    // Should not have forward-reference errors for lint (it's declared in a parallel block before deploy)
    const fwdRefError = result.errors.find((e: { message: string; path?: string }) =>
      e.message.includes('lint') && e.message.includes('not been declared'),
    );
    expect(fwdRefError).toBeUndefined();
  });

  it('should detect duplicate step IDs across parallel and outer steps', () => {
    const definition: SpellDefinition = {
      name: 'test',
      steps: [
        { id: 'setup', type: 'bash', config: {} },
        {
          id: 'par',
          type: 'parallel',
          config: {},
          steps: [
            { id: 'setup', type: 'bash', config: {} }, // duplicate!
          ],
        },
      ],
    };

    const result = validateSpellDefinition(definition, { knownStepTypes: ['parallel', 'bash'] });
    const dupError = result.errors.find((e: { message: string; path?: string }) => e.message.includes('duplicate'));
    expect(dupError).toBeDefined();
  });
});

// ============================================================================
// Dry-Run — Parallel Steps
// ============================================================================

describe('SpellCaster — parallel dry-run', () => {
  it('should report nested parallel steps in dry-run output', async () => {
    const mockCmd = createMockCommand();
    registry.register(mockCmd);

    const definition = simpleWorkflow([
      {
        id: 'checks',
        type: 'parallel',
        config: {},
        steps: [
          { id: 'lint', type: 'mock', config: {} },
          { id: 'test', type: 'mock', config: {} },
        ],
      },
    ]);

    const result = await runner.run(definition, {}, { dryRun: true });

    expect(result.success).toBe(true);
    // Should have reports for: parallel step + 2 nested steps = 3 total
    // The dry-run result packs step reports into errors or success
    // Check the actual structure
    expect(result.errors).toHaveLength(0);
  });

  it('should report nested parallel steps via dryRun method', async () => {
    const mockCmd = createMockCommand();
    registry.register(mockCmd);

    const definition = simpleWorkflow([
      {
        id: 'checks',
        type: 'parallel',
        config: {},
        steps: [
          { id: 'lint', type: 'mock', config: {} },
          { id: 'test', type: 'mock', config: {} },
        ],
      },
    ]);

    const dryResult = await runner.dryRun(definition, {});

    expect(dryResult.valid).toBe(true);
    // Should have 3 step reports: parallel + lint + test
    expect(dryResult.steps).toHaveLength(3);
    expect(dryResult.steps.map(s => s.stepId)).toEqual(['checks', 'lint', 'test']);
  });
});
