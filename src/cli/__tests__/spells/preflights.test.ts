/**
 * Preflight Checker Tests
 *
 * Runtime state validation that runs before any step executes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  collectPreflights,
  checkPreflights,
  formatPreflightErrors,
} from '../../spells/core/preflight-checker.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import type {
  StepCommand,
  PreflightCheck,
} from '../../spells/types/step-command.types.js';
import type { SpellDefinition, StepDefinition } from '../../spells/types/spell-definition.types.js';

function makeCommand(type: string, preflight?: readonly PreflightCheck[]): StepCommand {
  return {
    type,
    description: `${type} command`,
    configSchema: { type: 'object' },
    preflight,
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: { result: 'ok' }, duration: 1 }),
    describeOutputs: () => [{ name: 'result', type: 'string' }],
  };
}

function step(id: string, type: string, config: Record<string, unknown> = {}, extra: Partial<StepDefinition> = {}): StepDefinition {
  return { id, type, config, ...extra };
}

describe('collectPreflights', () => {
  it('collects step-command preflights bound to each step', () => {
    const registry = new StepCommandRegistry();
    const check: PreflightCheck = {
      name: 'issue-exists',
      check: vi.fn(async () => ({ passed: true })),
    };
    registry.register(makeCommand('github', [check]));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [
        step('s1', 'github', { issue: 10 }),
        step('s2', 'github', { issue: 20 }),
      ],
    };

    const preflights = collectPreflights(spell, registry, { args: {} });
    expect(preflights).toHaveLength(2);
    expect(preflights[0].stepId).toBe('s1');
    expect(preflights[1].stepId).toBe('s2');
  });

  it('collects YAML-declared preflights on steps', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [
        step('s1', 'bash', { command: 'echo ok' }, {
          preflight: [
            { name: 'tree-clean', command: 'git diff --quiet' },
          ],
        }),
      ],
    };

    const preflights = collectPreflights(spell, registry, { args: {} });
    expect(preflights).toHaveLength(1);
    expect(preflights[0].name).toBe('tree-clean');
  });

  it('combines step-command and YAML preflights', () => {
    const registry = new StepCommandRegistry();
    const check: PreflightCheck = {
      name: 'cmd-check',
      check: async () => ({ passed: true }),
    };
    registry.register(makeCommand('github', [check]));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [
        step('s1', 'github', { issue: 10 }, {
          preflight: [{ name: 'yaml-check', command: 'true' }],
        }),
      ],
    };

    const preflights = collectPreflights(spell, registry, { args: {} });
    expect(preflights).toHaveLength(2);
    expect(preflights.map(p => p.name).sort()).toEqual(['cmd-check', 'yaml-check']);
  });

  it('returns empty when no preflights declared', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));
    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'bash', { command: 'echo ok' })],
    };
    expect(collectPreflights(spell, registry, { args: {} })).toEqual([]);
  });
});

describe('checkPreflights', () => {
  it('passes when all checks pass', async () => {
    const registry = new StepCommandRegistry();
    const check: PreflightCheck = {
      name: 'ok',
      check: async () => ({ passed: true }),
    };
    registry.register(makeCommand('github', [check]));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'github', {})],
    };
    const results = await checkPreflights(collectPreflights(spell, registry, { args: {} }));
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('reports reason on failure', async () => {
    const registry = new StepCommandRegistry();
    const check: PreflightCheck = {
      name: 'issue-exists',
      check: async () => ({ passed: false, reason: 'issue #999 not found' }),
    };
    registry.register(makeCommand('github', [check]));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'github', { issue: 999 })],
    };
    const results = await checkPreflights(collectPreflights(spell, registry, { args: {} }));
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toBe('issue #999 not found');
    expect(results[0].stepId).toBe('s1');
  });

  it('treats thrown errors as failures', async () => {
    const registry = new StepCommandRegistry();
    const check: PreflightCheck = {
      name: 'boom',
      check: async () => { throw new Error('unexpected'); },
    };
    registry.register(makeCommand('github', [check]));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'github', {})],
    };
    const results = await checkPreflights(collectPreflights(spell, registry, { args: {} }));
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain('unexpected');
  });

  it('runs checks in parallel', async () => {
    const registry = new StepCommandRegistry();
    const delays: number[] = [];
    const makeSlow = (name: string, ms: number): PreflightCheck => ({
      name,
      check: async () => {
        const started = Date.now();
        await new Promise(r => setTimeout(r, ms));
        delays.push(Date.now() - started);
        return { passed: true };
      },
    });
    registry.register(makeCommand('github', [makeSlow('a', 40), makeSlow('b', 40)]));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'github', {})],
    };
    const start = Date.now();
    await checkPreflights(collectPreflights(spell, registry, { args: {} }));
    const total = Date.now() - start;
    // Sequential would be ~80ms, parallel ~40ms. Allow slack.
    expect(total).toBeLessThan(75);
  });
});

describe('YAML declarative preflights', () => {
  it('passes when shell command exits with expected code', async () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'bash', { command: 'echo ok' }, {
        preflight: [{ name: 'always-ok', command: process.platform === 'win32' ? 'exit 0' : 'true' }],
      })],
    };
    const results = await checkPreflights(collectPreflights(spell, registry, { args: {} }));
    expect(results[0].passed).toBe(true);
  });

  it('fails when exit code mismatches', async () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const spell: SpellDefinition = {
      name: 'test',
      steps: [step('s1', 'bash', { command: 'echo ok' }, {
        preflight: [{ name: 'always-fail', command: process.platform === 'win32' ? 'exit 1' : 'false' }],
      })],
    };
    const results = await checkPreflights(collectPreflights(spell, registry, { args: {} }));
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain('exited with');
  });
});

describe('formatPreflightErrors', () => {
  it('summarizes failures with human-friendly header and reason', () => {
    const out = formatPreflightErrors([
      { stepId: 's1', name: 'issue-exists', passed: false, reason: 'issue #10 not found' },
      { stepId: 's2', name: 'tree-clean', passed: true },
    ]);
    expect(out).toContain('prerequisite');
    expect(out).toContain('issue #10 not found');
    expect(out).not.toContain('tree-clean');
  });

  it('falls back to check name when no reason is provided', () => {
    const out = formatPreflightErrors([
      { stepId: 's1', name: 'working tree clean', passed: false },
    ]);
    expect(out).toContain('working tree clean');
  });

  it('uses plural header for multiple failures', () => {
    const out = formatPreflightErrors([
      { stepId: 's1', name: 'a', passed: false, reason: 'fail-a' },
      { stepId: 's2', name: 'b', passed: false, reason: 'fail-b' },
    ]);
    expect(out).toContain('2 prerequisites');
  });

  it('returns empty string when all pass', () => {
    expect(formatPreflightErrors([
      { stepId: 's1', name: 'ok', passed: true },
    ])).toBe('');
  });
});
