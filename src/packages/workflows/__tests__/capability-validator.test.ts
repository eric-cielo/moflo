/**
 * Capability Validator Tests
 *
 * Story #108: Tests for Tier 1 capability declaration and enforcement.
 */

import { describe, it, expect } from 'vitest';
import {
  checkCapabilities,
  isValidCapabilityType,
  validateStepCapabilities,
  formatViolations,
} from '../src/core/capability-validator.js';
import type { StepCommand, StepCapability } from '../src/types/step-command.types.js';
import type { StepDefinition } from '../src/types/workflow-definition.types.js';
import { bashCommand } from '../src/commands/bash-command.js';
import { agentCommand } from '../src/commands/agent-command.js';
import { memoryCommand } from '../src/commands/memory-command.js';
import { conditionCommand } from '../src/commands/condition-command.js';
import { waitCommand } from '../src/commands/wait-command.js';

// ============================================================================
// Helper: create a minimal StepDefinition
// ============================================================================

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id: 'test-step',
    type: 'bash',
    config: { command: 'echo hello' },
    ...overrides,
  };
}

// ============================================================================
// isValidCapabilityType
// ============================================================================

describe('isValidCapabilityType', () => {
  it('should accept all valid capability types', () => {
    const valid = ['fs:read', 'fs:write', 'net', 'shell', 'memory', 'credentials', 'browser', 'agent'];
    for (const type of valid) {
      expect(isValidCapabilityType(type)).toBe(true);
    }
  });

  it('should reject invalid capability types', () => {
    expect(isValidCapabilityType('execute')).toBe(false);
    expect(isValidCapabilityType('fs')).toBe(false);
    expect(isValidCapabilityType('')).toBe(false);
    expect(isValidCapabilityType('network')).toBe(false);
  });
});

// ============================================================================
// checkCapabilities
// ============================================================================

describe('checkCapabilities', () => {
  it('should allow step with no restrictions', () => {
    const step = makeStep();
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.effectiveCaps).toEqual(bashCommand.capabilities);
  });

  it('should allow step restricting to subset of command capabilities', () => {
    const step = makeStep({
      capabilities: { shell: ['echo', 'cat'] },
    });
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
    // shell should be restricted, fs:read and fs:write should be inherited
    const shellCap = result.effectiveCaps.find(c => c.type === 'shell');
    expect(shellCap?.scope).toEqual(['echo', 'cat']);
  });

  it('should block step granting undeclared capability', () => {
    const step = makeStep({
      capabilities: { browser: [] },
    });
    // bashCommand doesn't declare 'browser'
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].capability).toBe('browser');
    expect(result.violations[0].reason).toContain('cannot grant new capabilities');
  });

  it('should block unknown capability type', () => {
    const step = makeStep({
      capabilities: { 'teleport': ['anywhere'] } as Record<string, readonly string[]>,
    });
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toContain('unknown capability type');
  });

  it('should allow command with no capabilities (control-flow)', () => {
    const step = makeStep({ type: 'condition' });
    const result = checkCapabilities(step, conditionCommand);
    expect(result.allowed).toBe(true);
    expect(result.effectiveCaps).toEqual([]);
  });

  it('should block restriction on command with no capabilities', () => {
    const step = makeStep({
      type: 'condition',
      capabilities: { shell: ['echo'] },
    });
    const result = checkCapabilities(step, conditionCommand);
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toContain('cannot grant new capabilities');
  });

  it('should inherit unrestricted capabilities from command', () => {
    const step = makeStep({
      capabilities: { 'fs:read': ['./config/'] },
    });
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(true);
    // fs:read is restricted, but shell and fs:write should be inherited unchanged
    const shellCap = result.effectiveCaps.find(c => c.type === 'shell');
    expect(shellCap?.scope).toBeUndefined();
    const fsWriteCap = result.effectiveCaps.find(c => c.type === 'fs:write');
    expect(fsWriteCap?.scope).toBeUndefined();
    const fsReadCap = result.effectiveCaps.find(c => c.type === 'fs:read');
    expect(fsReadCap?.scope).toEqual(['./config/']);
  });

  it('should report multiple violations', () => {
    const step = makeStep({
      capabilities: {
        browser: [],
        net: ['example.com'],
      },
    });
    // bash doesn't have browser or net
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBe(2);
  });
});

// ============================================================================
// validateStepCapabilities (schema validation)
// ============================================================================

describe('validateStepCapabilities', () => {
  it('should pass with no capabilities', () => {
    const step = makeStep();
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors).toHaveLength(0);
  });

  it('should pass with valid capabilities', () => {
    const step = makeStep({
      capabilities: {
        'fs:read': ['./src/'],
        shell: ['echo'],
      },
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors).toHaveLength(0);
  });

  it('should reject non-object capabilities', () => {
    const step = makeStep({
      capabilities: ['shell'] as unknown as Record<string, readonly string[]>,
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('must be an object');
  });

  it('should reject unknown capability type', () => {
    const step = makeStep({
      capabilities: { teleport: ['anywhere'] } as Record<string, readonly string[]>,
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('unknown capability type');
  });

  it('should reject non-array scope', () => {
    const step = makeStep({
      capabilities: { shell: 'echo' as unknown as readonly string[] },
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('scope must be an array');
  });

  it('should reject non-string scope values', () => {
    const step = makeStep({
      capabilities: { shell: [42 as unknown as string] },
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('must be strings');
  });
});

// ============================================================================
// formatViolations
// ============================================================================

describe('formatViolations', () => {
  it('should format single violation', () => {
    const result = formatViolations([{
      capability: 'browser',
      reason: 'not declared',
      stepId: 's1',
      stepType: 'bash',
    }]);
    expect(result).toBe('[browser] not declared');
  });

  it('should format multiple violations', () => {
    const result = formatViolations([
      { capability: 'browser', reason: 'not declared', stepId: 's1', stepType: 'bash' },
      { capability: 'net', reason: 'not declared', stepId: 's1', stepType: 'bash' },
    ]);
    expect(result).toContain('[browser]');
    expect(result).toContain('[net]');
    expect(result).toContain('; ');
  });
});

// ============================================================================
// Built-in command capabilities
// ============================================================================

describe('built-in command capabilities', () => {
  it('bash command should declare shell, fs:read, fs:write', () => {
    expect(bashCommand.capabilities).toBeDefined();
    const types = bashCommand.capabilities!.map(c => c.type);
    expect(types).toContain('shell');
    expect(types).toContain('fs:read');
    expect(types).toContain('fs:write');
  });

  it('agent command should declare agent', () => {
    expect(agentCommand.capabilities).toBeDefined();
    const types = agentCommand.capabilities!.map(c => c.type);
    expect(types).toContain('agent');
  });

  it('memory command should declare memory', () => {
    expect(memoryCommand.capabilities).toBeDefined();
    const types = memoryCommand.capabilities!.map(c => c.type);
    expect(types).toContain('memory');
  });

  it('condition command should have no capabilities', () => {
    expect(conditionCommand.capabilities).toBeUndefined();
  });

  it('wait command should have no capabilities', () => {
    expect(waitCommand.capabilities).toBeUndefined();
  });
});
