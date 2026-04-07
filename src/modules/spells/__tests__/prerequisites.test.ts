/**
 * Prerequisite Checker Tests
 *
 * Story #193: Tests for the workflow engine prerequisites system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectPrerequisites,
  checkPrerequisites,
  formatPrerequisiteErrors,
} from '../src/core/prerequisite-checker.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { SpellCaster } from '../src/core/runner.js';
import type {
  StepCommand,
  Prerequisite,
  PrerequisiteResult,
  CredentialAccessor,
  MemoryAccessor,
} from '../src/types/step-command.types.js';
import type { SpellDefinition } from '../src/types/workflow-definition.types.js';

// ============================================================================
// Helpers
// ============================================================================

function makePrereq(name: string, satisfied: boolean, hint = `Install ${name}`): Prerequisite {
  return {
    name,
    check: vi.fn(async () => satisfied),
    installHint: hint,
    url: `https://example.com/${name}`,
  };
}

function makeCommand(type: string, prereqs?: readonly Prerequisite[]): StepCommand {
  return {
    type,
    description: `${type} command`,
    configSchema: { type: 'object' },
    prerequisites: prereqs,
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: { result: 'ok' }, duration: 1 }),
    describeOutputs: () => [{ name: 'result', type: 'string' }],
  };
}

function simpleWorkflow(steps: SpellDefinition['steps']): SpellDefinition {
  return { name: 'test', steps };
}

function createMockCredentials(): CredentialAccessor {
  return {
    async get() { return undefined; },
    async has() { return false; },
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

// ============================================================================
// collectPrerequisites
// ============================================================================

describe('collectPrerequisites', () => {
  it('collects prerequisites from multiple step commands', () => {
    const registry = new StepCommandRegistry();
    const ghPrereq = makePrereq('gh', true);
    const claudePrereq = makePrereq('claude', true);

    registry.register(makeCommand('github', [ghPrereq]));
    registry.register(makeCommand('agent', [claudePrereq]));
    registry.register(makeCommand('bash'));

    const def = simpleWorkflow([
      { id: 's1', type: 'github', config: {} },
      { id: 's2', type: 'agent', config: {} },
      { id: 's3', type: 'bash', config: {} },
    ]);

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(2);
    expect(prereqs.map(p => p.name)).toEqual(['gh', 'claude']);
  });

  it('deduplicates prerequisites by name', () => {
    const registry = new StepCommandRegistry();
    const ghPrereq = makePrereq('gh', true);

    registry.register(makeCommand('github', [ghPrereq]));
    // Second command type that also needs gh
    const cmd2 = makeCommand('github-pr', [ghPrereq]);
    registry.register(cmd2);

    const def = simpleWorkflow([
      { id: 's1', type: 'github', config: {} },
      { id: 's2', type: 'github-pr', config: {} },
    ]);

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(1);
    expect(prereqs[0].name).toBe('gh');
  });

  it('returns empty array when no prerequisites', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const def = simpleWorkflow([{ id: 's1', type: 'bash', config: {} }]);
    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(0);
  });

  it('ignores steps with unknown command types', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const def = simpleWorkflow([
      { id: 's1', type: 'unknown-type', config: {} },
      { id: 's2', type: 'bash', config: {} },
    ]);

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(0);
  });
});

// ============================================================================
// checkPrerequisites
// ============================================================================

describe('checkPrerequisites', () => {
  it('returns satisfied for all passing checks', async () => {
    const prereqs = [makePrereq('gh', true), makePrereq('claude', true)];
    const results = await checkPrerequisites(prereqs);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.satisfied)).toBe(true);
  });

  it('returns unsatisfied for failing checks', async () => {
    const prereqs = [makePrereq('gh', true), makePrereq('playwright', false)];
    const results = await checkPrerequisites(prereqs);

    expect(results).toHaveLength(2);
    expect(results[0].satisfied).toBe(true);
    expect(results[1].satisfied).toBe(false);
    expect(results[1].name).toBe('playwright');
  });

  it('treats check() exceptions as unsatisfied', async () => {
    const errPrereq: Prerequisite = {
      name: 'broken',
      check: async () => { throw new Error('boom'); },
      installHint: 'Fix it',
    };
    const results = await checkPrerequisites([errPrereq]);

    expect(results).toHaveLength(1);
    expect(results[0].satisfied).toBe(false);
    expect(results[0].name).toBe('broken');
  });

  it('runs each check exactly once', async () => {
    const checkFn = vi.fn(async () => true);
    const prereq: Prerequisite = { name: 'gh', check: checkFn, installHint: '' };

    await checkPrerequisites([prereq]);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// formatPrerequisiteErrors
// ============================================================================

describe('formatPrerequisiteErrors', () => {
  it('formats failed prerequisites with install hints', () => {
    const results: PrerequisiteResult[] = [
      { name: 'gh', satisfied: false, installHint: 'brew install gh', url: 'https://cli.github.com' },
      { name: 'claude', satisfied: false, installHint: 'npm i -g @anthropic-ai/claude-code' },
    ];

    const msg = formatPrerequisiteErrors(results);
    expect(msg).toContain('Missing prerequisites:');
    expect(msg).toContain('gh: brew install gh');
    expect(msg).toContain('https://cli.github.com');
    expect(msg).toContain('claude: npm i -g @anthropic-ai/claude-code');
  });

  it('returns empty string when all satisfied', () => {
    const results: PrerequisiteResult[] = [
      { name: 'gh', satisfied: true, installHint: '' },
    ];
    expect(formatPrerequisiteErrors(results)).toBe('');
  });

  it('only includes failed prerequisites', () => {
    const results: PrerequisiteResult[] = [
      { name: 'gh', satisfied: true, installHint: '' },
      { name: 'playwright', satisfied: false, installHint: 'npm i playwright' },
    ];
    const msg = formatPrerequisiteErrors(results);
    expect(msg).not.toMatch(/\bgh\b/);
    expect(msg).toContain('playwright');
  });
});

// ============================================================================
// Runner integration
// ============================================================================

describe('SpellCaster — prerequisite integration', () => {
  let registry: StepCommandRegistry;
  let runner: SpellCaster;

  beforeEach(() => {
    registry = new StepCommandRegistry();
    runner = new SpellCaster(registry, createMockCredentials(), createMockMemory());
  });

  it('fails workflow when prerequisites are not met', async () => {
    const failingPrereq = makePrereq('gh', false, 'Install: brew install gh');
    registry.register(makeCommand('github', [failingPrereq]));

    const def = simpleWorkflow([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {});

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('PREREQUISITES_FAILED');
    expect(result.errors[0].message).toContain('gh');
    expect(result.errors[0].message).toContain('brew install gh');
  });

  it('succeeds when all prerequisites are met', async () => {
    const passingPrereq = makePrereq('gh', true);
    registry.register(makeCommand('github', [passingPrereq]));

    const def = simpleWorkflow([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {});

    expect(result.success).toBe(true);
  });

  it('skips prerequisite checks in dry-run mode', async () => {
    const failingPrereq = makePrereq('gh', false);
    registry.register(makeCommand('github', [failingPrereq]));

    const def = simpleWorkflow([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {}, { dryRun: true });

    // dry-run reports step validity, not prerequisite failure
    expect(result.errors.every(e => e.code !== 'PREREQUISITES_FAILED')).toBe(true);
  });

  it('reports prerequisite status in dry-run step reports', async () => {
    const ghPrereq = makePrereq('gh', true);
    const claudePrereq = makePrereq('claude', false);
    registry.register(makeCommand('github', [ghPrereq]));
    registry.register(makeCommand('agent', [claudePrereq]));

    const def = simpleWorkflow([
      { id: 's1', type: 'github', config: {} },
      { id: 's2', type: 'agent', config: {} },
    ]);

    const dryResult = await runner.dryRun(def, {});
    const s1Report = dryResult.steps.find(s => s.stepId === 's1')!;
    const s2Report = dryResult.steps.find(s => s.stepId === 's2')!;

    expect(s1Report.prerequisiteResults).toHaveLength(1);
    expect(s1Report.prerequisiteResults![0].satisfied).toBe(true);

    expect(s2Report.prerequisiteResults).toHaveLength(1);
    expect(s2Report.prerequisiteResults![0].satisfied).toBe(false);
  });
});
