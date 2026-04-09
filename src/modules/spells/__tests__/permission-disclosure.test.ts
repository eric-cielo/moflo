/**
 * Permission Disclosure and Acceptance Gate Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  analyzeStepPermissions,
  analyzeSpellPermissions,
  formatStepPermissionReport,
  formatSpellPermissionReport,
} from '../src/core/permission-disclosure.js';
import {
  recordAcceptance,
  checkAcceptance,
  clearAcceptance,
} from '../src/core/permission-acceptance.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { bashCommand } from '../src/commands/bash-command.js';
import { agentCommand } from '../src/commands/agent-command.js';
import { memoryCommand } from '../src/commands/memory-command.js';
import { conditionCommand } from '../src/commands/condition-command.js';
import type { StepDefinition, SpellDefinition } from '../src/types/spell-definition.types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// Test Fixtures
// ============================================================================

function makeRegistry(): StepCommandRegistry {
  const reg = new StepCommandRegistry();
  reg.register(bashCommand);
  reg.register(agentCommand);
  reg.register(memoryCommand);
  reg.register(conditionCommand);
  return reg;
}

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id: 'test-step',
    type: 'bash',
    config: { command: 'echo hello' },
    ...overrides,
  };
}

function makeSpell(steps: StepDefinition[]): SpellDefinition {
  return {
    name: 'test-spell',
    version: '1.0',
    steps,
  };
}

// ============================================================================
// analyzeStepPermissions
// ============================================================================

describe('analyzeStepPermissions', () => {
  const registry = makeRegistry();

  it('classifies bash step as destructive (has shell + fs:write)', () => {
    const step = makeStep({ id: 'deploy', type: 'bash' });
    const report = analyzeStepPermissions(step, registry);

    expect(report.riskLevel).toBe('destructive');
    expect(report.permissionLevel).toBe('elevated');
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some(w => w.capability === 'shell')).toBe(true);
    expect(report.warnings.some(w => w.capability === 'fs:write')).toBe(true);
  });

  it('classifies agent step as sensitive (has agent capability)', () => {
    const step = makeStep({ id: 'research', type: 'agent', config: { prompt: 'hello' } });
    const report = analyzeStepPermissions(step, registry);

    expect(report.riskLevel).toBe('sensitive');
    expect(report.warnings.some(w => w.capability === 'agent')).toBe(true);
  });

  it('classifies memory step as safe', () => {
    const step = makeStep({
      id: 'save',
      type: 'memory',
      config: { action: 'write', namespace: 'test', key: 'k', value: 'v' },
    });
    const report = analyzeStepPermissions(step, registry);

    expect(report.riskLevel).toBe('safe');
    expect(report.warnings.length).toBe(0);
  });

  it('classifies condition step as safe (no I/O)', () => {
    const step = makeStep({
      id: 'check',
      type: 'condition',
      config: { expression: 'true', then: 'next' },
    });
    const report = analyzeStepPermissions(step, registry);

    expect(report.riskLevel).toBe('safe');
  });

  it('respects explicit permissionLevel override', () => {
    const step = makeStep({ id: 'restricted', type: 'bash', permissionLevel: 'readonly' });
    const report = analyzeStepPermissions(step, registry);

    // permissionLevel is readonly even though bash has shell caps
    expect(report.permissionLevel).toBe('readonly');
    // But the risk is still classified based on capabilities
    expect(report.riskLevel).toBe('destructive');
  });

  it('includes scope info in warnings when capabilities are scoped', () => {
    const step = makeStep({
      id: 'read-config',
      type: 'bash',
      capabilities: { 'fs:read': ['./config/'], 'shell': ['cat'] },
    });
    const report = analyzeStepPermissions(step, registry);

    const shellWarning = report.warnings.find(w => w.capability === 'shell');
    expect(shellWarning).toBeDefined();
    expect(shellWarning!.scope).toEqual(['cat']);
  });
});

// ============================================================================
// analyzeSpellPermissions
// ============================================================================

describe('analyzeSpellPermissions', () => {
  const registry = makeRegistry();

  it('computes overall risk as highest step risk', () => {
    const spell = makeSpell([
      makeStep({ id: 'safe', type: 'memory', config: { action: 'read', namespace: 'x', key: 'k' } }),
      makeStep({ id: 'dangerous', type: 'bash', config: { command: 'rm -rf /' } }),
    ]);

    const report = analyzeSpellPermissions(spell, registry);

    expect(report.overallRisk).toBe('destructive');
    expect(report.steps.length).toBe(2);
  });

  it('reports safe when all steps are safe', () => {
    const spell = makeSpell([
      makeStep({ id: 'check', type: 'condition', config: { expression: 'true', then: 'done' } }),
      makeStep({ id: 'save', type: 'memory', config: { action: 'read', namespace: 'x', key: 'k' } }),
    ]);

    const report = analyzeSpellPermissions(spell, registry);
    expect(report.overallRisk).toBe('safe');
  });

  it('generates a stable permission hash', () => {
    const spell = makeSpell([
      makeStep({ id: 'step1', type: 'bash', config: { command: 'echo hello' } }),
    ]);

    const report1 = analyzeSpellPermissions(spell, registry);
    const report2 = analyzeSpellPermissions(spell, registry);

    expect(report1.permissionHash).toBe(report2.permissionHash);
    expect(report1.permissionHash.length).toBe(16);
  });

  it('hash changes when capabilities change', () => {
    const spell1 = makeSpell([
      makeStep({ id: 'step1', type: 'bash', config: { command: 'echo hello' } }),
    ]);
    const spell2 = makeSpell([
      makeStep({ id: 'step1', type: 'memory', config: { action: 'read', namespace: 'x', key: 'k' } }),
    ]);

    const hash1 = analyzeSpellPermissions(spell1, registry).permissionHash;
    const hash2 = analyzeSpellPermissions(spell2, registry).permissionHash;

    expect(hash1).not.toBe(hash2);
  });

  it('hash changes when steps are added', () => {
    const spell1 = makeSpell([
      makeStep({ id: 'step1', type: 'bash', config: { command: 'echo hello' } }),
    ]);
    const spell2 = makeSpell([
      makeStep({ id: 'step1', type: 'bash', config: { command: 'echo hello' } }),
      makeStep({ id: 'step2', type: 'bash', config: { command: 'echo world' } }),
    ]);

    const hash1 = analyzeSpellPermissions(spell1, registry).permissionHash;
    const hash2 = analyzeSpellPermissions(spell2, registry).permissionHash;

    expect(hash1).not.toBe(hash2);
  });

  it('aggregates warnings from nested steps', () => {
    const spell = makeSpell([
      makeStep({
        id: 'loop',
        type: 'condition',
        config: { expression: 'true', then: 'done' },
        steps: [
          makeStep({ id: 'nested-bash', type: 'bash', config: { command: 'ls' } }),
        ],
      }),
    ]);

    const report = analyzeSpellPermissions(spell, registry);
    expect(report.allWarnings.some(w => w.capability === 'shell')).toBe(true);
    expect(report.overallRisk).toBe('destructive');
  });
});

// ============================================================================
// Formatting
// ============================================================================

describe('formatStepPermissionReport', () => {
  const registry = makeRegistry();

  it('includes [DESTRUCTIVE] marker for bash steps', () => {
    const step = makeStep({ id: 'deploy', type: 'bash' });
    const report = analyzeStepPermissions(step, registry);
    const output = formatStepPermissionReport(report);

    expect(output).toContain('[DESTRUCTIVE]');
    expect(output).toContain('deploy');
    expect(output).toContain('elevated');
    expect(output).toContain('!! shell');
  });

  it('includes [SAFE] marker for safe steps', () => {
    const step = makeStep({
      id: 'check',
      type: 'condition',
      config: { expression: 'true', then: 'done' },
    });
    const report = analyzeStepPermissions(step, registry);
    const output = formatStepPermissionReport(report);

    expect(output).toContain('[SAFE]');
  });
});

describe('formatSpellPermissionReport', () => {
  const registry = makeRegistry();

  it('includes DESTRUCTIVE STEPS summary for destructive spells', () => {
    const spell = makeSpell([
      makeStep({ id: 'safe-step', type: 'memory', config: { action: 'read', namespace: 'x', key: 'k' } }),
      makeStep({ id: 'danger-step', type: 'bash', config: { command: 'deploy' } }),
    ]);

    const report = analyzeSpellPermissions(spell, registry);
    const output = formatSpellPermissionReport(report);

    expect(output).toContain('DESTRUCTIVE STEPS');
    expect(output).toContain('danger-step');
    expect(output).toContain('Permission hash');
  });
});

// ============================================================================
// Acceptance Gate
// ============================================================================

describe('permission acceptance gate', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'moflo-accept-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns no-acceptance when no record exists', async () => {
    const result = await checkAcceptance(tempDir, 'my-spell', 'abc123');
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-acceptance');
  });

  it('records and verifies acceptance', async () => {
    await recordAcceptance(tempDir, 'my-spell', 'abc123');
    const result = await checkAcceptance(tempDir, 'my-spell', 'abc123');

    expect(result.accepted).toBe(true);
    expect(result.record?.permissionHash).toBe('abc123');
  });

  it('rejects stale acceptance when hash changes', async () => {
    await recordAcceptance(tempDir, 'my-spell', 'old-hash');
    const result = await checkAcceptance(tempDir, 'my-spell', 'new-hash');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('hash-mismatch');
    expect(result.record?.permissionHash).toBe('old-hash');
  });

  it('clears acceptance', async () => {
    await recordAcceptance(tempDir, 'my-spell', 'abc123');
    await clearAcceptance(tempDir, 'my-spell');
    const result = await checkAcceptance(tempDir, 'my-spell', 'abc123');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-acceptance');
  });

  it('handles special characters in spell names', async () => {
    await recordAcceptance(tempDir, 'epic/123-deploy', 'hash1');
    const result = await checkAcceptance(tempDir, 'epic/123-deploy', 'hash1');

    expect(result.accepted).toBe(true);
  });
});
