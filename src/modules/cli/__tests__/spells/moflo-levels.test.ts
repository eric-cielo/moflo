/**
 * MoFlo Integration Levels Tests
 *
 * Story #109: Tests for MoFlo integration level resolution, validation,
 * and enforcement in the spell engine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidMofloLevel,
  compareMofloLevels,
  getDefaultMofloLevel,
  resolveMofloLevel,
} from '../../src/spells/core/capability-validator.js';
import { MOFLO_LEVEL_ORDER, DEFAULT_MAX_NESTING_DEPTH } from '../../src/spells/types/step-command.types.js';
import type { MofloLevel, StepCommand } from '../../src/spells/types/step-command.types.js';
import type { StepDefinition, SpellDefinition } from '../../src/spells/types/spell-definition.types.js';
import { SpellCaster } from '../../src/spells/core/runner.js';
import { StepCommandRegistry } from '../../src/spells/core/step-command-registry.js';
import type { CredentialAccessor, MemoryAccessor } from '../../src/spells/types/step-command.types.js';
import { validateSpellDefinition } from '../../src/spells/schema/validator.js';
import {
  agentCommand,
  bashCommand,
  conditionCommand,
  waitCommand,
  loopCommand,
  memoryCommand,
  browserCommand,
  promptCommand,
} from '../../src/spells/commands/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id: 'test-step',
    type: 'bash',
    config: { command: 'echo hello' },
    ...overrides,
  };
}

function makeCommand(overrides: Partial<StepCommand> = {}): StepCommand {
  return {
    type: 'mock',
    description: 'Mock command',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: { result: 'ok' }, duration: 1 }),
    describeOutputs: () => [{ name: 'result', type: 'string' }],
    ...overrides,
  };
}

function makeSpell(overrides: Partial<SpellDefinition> = {}): SpellDefinition {
  return {
    name: 'test-spell',
    steps: [makeStep()],
    ...overrides,
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

function createMockCredentials(): CredentialAccessor {
  return {
    async get() { return undefined; },
    async has() { return false; },
  };
}

// ============================================================================
// isValidMofloLevel
// ============================================================================

describe('isValidMofloLevel', () => {
  it('should accept all valid levels', () => {
    for (const level of MOFLO_LEVEL_ORDER) {
      expect(isValidMofloLevel(level)).toBe(true);
    }
  });

  it('should reject invalid levels', () => {
    expect(isValidMofloLevel('admin')).toBe(false);
    expect(isValidMofloLevel('')).toBe(false);
    expect(isValidMofloLevel('NONE')).toBe(false);
    expect(isValidMofloLevel('memory-plus')).toBe(false);
  });
});

// ============================================================================
// compareMofloLevels
// ============================================================================

describe('compareMofloLevels', () => {
  it('should return 0 for equal levels', () => {
    expect(compareMofloLevels('none', 'none')).toBe(0);
    expect(compareMofloLevels('full', 'full')).toBe(0);
  });

  it('should return negative when first is less permissive', () => {
    expect(compareMofloLevels('none', 'memory')).toBeLessThan(0);
    expect(compareMofloLevels('memory', 'hooks')).toBeLessThan(0);
    expect(compareMofloLevels('hooks', 'full')).toBeLessThan(0);
    expect(compareMofloLevels('full', 'recursive')).toBeLessThan(0);
    expect(compareMofloLevels('none', 'recursive')).toBeLessThan(0);
  });

  it('should return positive when first is more permissive', () => {
    expect(compareMofloLevels('recursive', 'none')).toBeGreaterThan(0);
    expect(compareMofloLevels('full', 'memory')).toBeGreaterThan(0);
  });
});

// ============================================================================
// getDefaultMofloLevel
// ============================================================================

describe('getDefaultMofloLevel', () => {
  it('should return none when no command is provided', () => {
    expect(getDefaultMofloLevel('agent')).toBe('none');
    expect(getDefaultMofloLevel('bash')).toBe('none');
    expect(getDefaultMofloLevel('custom-step')).toBe('none');
  });

  it('should return command defaultMofloLevel when set', () => {
    const command = makeCommand({ defaultMofloLevel: 'hooks' });
    expect(getDefaultMofloLevel('bash', command)).toBe('hooks');
  });

  it('should return none when command has no defaultMofloLevel', () => {
    const command = makeCommand({ defaultMofloLevel: undefined });
    expect(getDefaultMofloLevel('agent', command)).toBe('none');
  });

  it('should return correct level for built-in agent command', () => {
    expect(getDefaultMofloLevel('agent', agentCommand)).toBe('memory');
  });

  it('should return correct level for built-in bash command', () => {
    expect(getDefaultMofloLevel('bash', bashCommand)).toBe('none');
  });
});

// ============================================================================
// resolveMofloLevel
// ============================================================================

describe('resolveMofloLevel', () => {
  it('should use command default when no overrides', () => {
    const step = makeStep({ type: 'agent' });
    const command = makeCommand({ defaultMofloLevel: 'memory' });
    expect(resolveMofloLevel(step, command, undefined, undefined)).toBe('memory');
  });

  it('should allow step to narrow below spell level', () => {
    const step = makeStep({ mofloLevel: 'none' });
    const command = makeCommand({ defaultMofloLevel: 'memory' });
    expect(resolveMofloLevel(step, command, 'full', undefined)).toBe('none');
  });

  it('should cap step level at spell level', () => {
    const step = makeStep({ mofloLevel: 'full' });
    const command = makeCommand({ defaultMofloLevel: 'memory' });
    expect(resolveMofloLevel(step, command, 'memory', undefined)).toBe('memory');
  });

  it('should cap at parent level for recursive spells', () => {
    const step = makeStep({ mofloLevel: 'full' });
    const command = makeCommand({ defaultMofloLevel: 'memory' });
    expect(resolveMofloLevel(step, command, 'recursive', 'hooks')).toBe('hooks');
  });

  it('should not escalate beyond parent even without spell level', () => {
    const step = makeStep({ type: 'agent' });
    const command = makeCommand({ defaultMofloLevel: 'full' });
    expect(resolveMofloLevel(step, command, undefined, 'memory')).toBe('memory');
  });

  it('should fall back to none when no command provided', () => {
    const step = makeStep({ type: 'agent' });
    expect(resolveMofloLevel(step, undefined, undefined, undefined)).toBe('none');
  });
});

// ============================================================================
// mofloLevel validation (via validateSpellDefinition)
// ============================================================================

describe('mofloLevel validation', () => {
  it('should pass with no mofloLevel set', () => {
    const def = makeSpell();
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should pass with valid spell mofloLevel', () => {
    const def = makeSpell({ mofloLevel: 'memory' });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid spell mofloLevel', () => {
    const def = makeSpell({ mofloLevel: 'admin' as MofloLevel });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'mofloLevel' && e.message.includes('invalid mofloLevel'))).toBe(true);
  });

  it('should pass with valid step mofloLevel', () => {
    const def = makeSpell({
      steps: [makeStep({ mofloLevel: 'memory' })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid step mofloLevel', () => {
    const def = makeSpell({
      steps: [makeStep({ mofloLevel: 'super' as MofloLevel })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('invalid mofloLevel'))).toBe(true);
  });

  it('should reject step mofloLevel that exceeds spell level', () => {
    const def = makeSpell({
      mofloLevel: 'memory',
      steps: [makeStep({ mofloLevel: 'full' })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('exceeds spell-level'))).toBe(true);
  });

  it('should allow step level equal to spell level', () => {
    const def = makeSpell({
      mofloLevel: 'hooks',
      steps: [makeStep({ mofloLevel: 'hooks' })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should allow step level below spell level', () => {
    const def = makeSpell({
      mofloLevel: 'full',
      steps: [makeStep({ mofloLevel: 'none' })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should validate nested steps in loops', () => {
    const def = makeSpell({
      mofloLevel: 'memory',
      steps: [{
        id: 'loop1',
        type: 'loop',
        config: { over: [1, 2] },
        steps: [makeStep({ id: 'nested1', mofloLevel: 'recursive' })],
      }],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('exceeds spell-level'))).toBe(true);
  });
});

// ============================================================================
// Schema validation integration
// ============================================================================

describe('validateSpellDefinition with mofloLevel', () => {
  it('should pass validation with valid mofloLevel', () => {
    const def = makeSpell({
      mofloLevel: 'hooks',
      steps: [makeStep({ mofloLevel: 'none' })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should fail validation with escalating step level', () => {
    const def = makeSpell({
      mofloLevel: 'none',
      steps: [makeStep({ mofloLevel: 'full' })],
    });
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('exceeds'))).toBe(true);
  });
});

// ============================================================================
// Built-in command defaultMofloLevel
// ============================================================================

describe('built-in command defaultMofloLevel', () => {
  it('agent command defaults to memory', () => {
    expect(agentCommand.defaultMofloLevel).toBe('memory');
  });

  it('bash command defaults to none', () => {
    expect(bashCommand.defaultMofloLevel).toBe('none');
  });

  it('memory command defaults to memory', () => {
    expect(memoryCommand.defaultMofloLevel).toBe('memory');
  });

  it('browser command defaults to memory', () => {
    expect(browserCommand.defaultMofloLevel).toBe('memory');
  });

  it('condition command defaults to none', () => {
    expect(conditionCommand.defaultMofloLevel).toBe('none');
  });

  it('wait command defaults to none', () => {
    expect(waitCommand.defaultMofloLevel).toBe('none');
  });

  it('loop command defaults to none', () => {
    expect(loopCommand.defaultMofloLevel).toBe('none');
  });

  it('prompt command defaults to none', () => {
    expect(promptCommand.defaultMofloLevel).toBe('none');
  });
});

// ============================================================================
// Runner integration — mofloLevel in context
// ============================================================================

describe('SpellCaster — mofloLevel enforcement', () => {
  let registry: StepCommandRegistry;
  let runner: SpellCaster;

  beforeEach(() => {
    registry = new StepCommandRegistry();
    runner = new SpellCaster(registry, createMockCredentials(), createMockMemory());
  });

  it('should pass mofloLevel to step context', async () => {
    let capturedLevel: string | undefined;
    registry.register(makeCommand({
      defaultMofloLevel: 'memory',
      execute: async (_config, context) => {
        capturedLevel = context.mofloLevel;
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const def = makeSpell({
      steps: [{ id: 's1', type: 'mock', config: {} }],
    });

    const result = await runner.run(def, {});
    expect(result.success).toBe(true);
    expect(capturedLevel).toBe('memory');
  });

  it('should resolve step-level override', async () => {
    let capturedLevel: string | undefined;
    registry.register(makeCommand({
      defaultMofloLevel: 'memory',
      execute: async (_config, context) => {
        capturedLevel = context.mofloLevel;
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const def = makeSpell({
      mofloLevel: 'full',
      steps: [{ id: 's1', type: 'mock', config: {}, mofloLevel: 'none' }],
    });

    const result = await runner.run(def, {});
    expect(result.success).toBe(true);
    expect(capturedLevel).toBe('none');
  });

  it('should cap step level at spell level', async () => {
    let capturedLevel: string | undefined;
    registry.register(makeCommand({
      defaultMofloLevel: 'full',
      execute: async (_config, context) => {
        capturedLevel = context.mofloLevel;
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const def = makeSpell({
      mofloLevel: 'memory',
      steps: [{ id: 's1', type: 'mock', config: {} }],
    });

    const result = await runner.run(def, {});
    expect(result.success).toBe(true);
    expect(capturedLevel).toBe('memory');
  });

  it('should enforce parent level constraint on per-step resolution', async () => {
    let capturedLevel: string | undefined;
    registry.register(makeCommand({
      defaultMofloLevel: 'full',
      execute: async (_config, context) => {
        capturedLevel = context.mofloLevel;
        return { success: true, data: {}, duration: 1 };
      },
    }));

    // Spell does NOT declare mofloLevel (so no spell-level vs parent check),
    // but the command's default 'full' should be capped by parentMofloLevel 'hooks'
    const def = makeSpell({
      steps: [{ id: 's1', type: 'mock', config: {} }],
    });

    const result = await runner.run(def, {}, { parentMofloLevel: 'hooks' });
    expect(result.success).toBe(true);
    expect(capturedLevel).toBe('hooks');
  });

  it('should fail nested spell that exceeds parent level', async () => {
    registry.register(makeCommand());

    const def = makeSpell({
      mofloLevel: 'full',
      steps: [{ id: 's1', type: 'mock', config: {} }],
    });

    const result = await runner.run(def, {}, { parentMofloLevel: 'memory' });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('MOFLO_LEVEL_DENIED');
  });

  it('should pass nestingDepth to context', async () => {
    let capturedDepth: number | undefined;
    registry.register(makeCommand({
      execute: async (_config, context) => {
        capturedDepth = context.nestingDepth;
        return { success: true, data: {}, duration: 1 };
      },
    }));

    const def = makeSpell({
      steps: [{ id: 's1', type: 'mock', config: {} }],
    });

    const result = await runner.run(def, {}, { nestingDepth: 2 });
    expect(result.success).toBe(true);
    expect(capturedDepth).toBe(2);
  });

  it('should report mofloLevel in dry-run step reports', async () => {
    registry.register(makeCommand({ defaultMofloLevel: 'hooks' }));

    const def = makeSpell({
      steps: [{ id: 's1', type: 'mock', config: {} }],
    });

    const result = await runner.dryRun(def, {});
    expect(result.valid).toBe(true);
    expect(result.steps[0].mofloLevel).toBe('hooks');
  });
});

// ============================================================================
// DEFAULT_MAX_NESTING_DEPTH
// ============================================================================

describe('DEFAULT_MAX_NESTING_DEPTH', () => {
  it('should be 3', () => {
    expect(DEFAULT_MAX_NESTING_DEPTH).toBe(3);
  });
});
