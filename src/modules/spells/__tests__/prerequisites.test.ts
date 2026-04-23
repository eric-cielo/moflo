/**
 * Prerequisite Checker Tests
 *
 * Story #193: Tests for the spell engine prerequisites system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectPrerequisites,
  checkPrerequisites,
  formatPrerequisiteErrors,
  compilePrerequisiteSpec,
  resolveUnmetPrerequisites,
  type PromptLineFn,
} from '../src/core/prerequisite-checker.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { SpellCaster } from '../src/core/runner.js';
import { parseSpell } from '../src/schema/parser.js';
import { validateSpellDefinition } from '../src/schema/validator.js';
import type {
  StepCommand,
  Prerequisite,
  PrerequisiteResult,
  CredentialAccessor,
  MemoryAccessor,
} from '../src/types/step-command.types.js';
import type {
  SpellDefinition,
  PrerequisiteSpec,
} from '../src/types/spell-definition.types.js';
import * as fsPromises from 'node:fs/promises';
import { accessSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

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

function simpleSpell(steps: SpellDefinition['steps']): SpellDefinition {
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

    const def = simpleSpell([
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

    const def = simpleSpell([
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

    const def = simpleSpell([{ id: 's1', type: 'bash', config: {} }]);
    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(0);
  });

  it('ignores steps with unknown command types', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const def = simpleSpell([
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

  it('fails spell when prerequisites are not met', async () => {
    const failingPrereq = makePrereq('gh', false, 'Install: brew install gh');
    registry.register(makeCommand('github', [failingPrereq]));

    const def = simpleSpell([{ id: 's1', type: 'github', config: {} }]);
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

    const def = simpleSpell([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {});

    expect(result.success).toBe(true);
  });

  it('skips prerequisite checks in dry-run mode', async () => {
    const failingPrereq = makePrereq('gh', false);
    registry.register(makeCommand('github', [failingPrereq]));

    const def = simpleSpell([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {}, { dryRun: true });

    // dry-run reports step validity, not prerequisite failure
    expect(result.errors.every(e => e.code !== 'PREREQUISITES_FAILED')).toBe(true);
  });

  it('collects and fails on spell-level YAML prereq', async () => {
    registry.register(makeCommand('bash'));

    const def: SpellDefinition = {
      name: 'needs-env',
      prerequisites: [{
        name: 'FLO_TEST_MISSING_460',
        description: 'Test env var',
        docsUrl: 'https://example.com/460',
        detect: { type: 'env', key: 'FLO_TEST_MISSING_460' },
        promptOnMissing: false, // force non-prompt fail-fast path
      }],
      steps: [{ id: 's1', type: 'bash', config: {} }],
    };

    delete process.env.FLO_TEST_MISSING_460;
    const result = await runner.run(def, {});

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREREQUISITES_FAILED');
    expect(result.errors[0].message).toContain('FLO_TEST_MISSING_460');
    expect(result.errors[0].message).toContain('https://example.com/460');
  });

  it('reports prerequisite status in dry-run step reports', async () => {
    const ghPrereq = makePrereq('gh', true);
    const claudePrereq = makePrereq('claude', false);
    registry.register(makeCommand('github', [ghPrereq]));
    registry.register(makeCommand('agent', [claudePrereq]));

    const def = simpleSpell([
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

// ============================================================================
// compilePrerequisiteSpec — detectors (#460)
// ============================================================================

describe('compilePrerequisiteSpec', () => {
  it('env detector: passes when env var is set to non-empty', async () => {
    process.env.FLO_PREREQ_TEST_ENV = 'value';
    const compiled = compilePrerequisiteSpec({
      name: 'TEST_ENV',
      detect: { type: 'env', key: 'FLO_PREREQ_TEST_ENV' },
    });
    expect(await compiled.check()).toBe(true);
    expect(compiled.envKey).toBe('FLO_PREREQ_TEST_ENV');
    delete process.env.FLO_PREREQ_TEST_ENV;
  });

  it('env detector: fails when env var is unset', async () => {
    delete process.env.FLO_PREREQ_TEST_ENV;
    const compiled = compilePrerequisiteSpec({
      name: 'TEST_ENV',
      detect: { type: 'env', key: 'FLO_PREREQ_TEST_ENV' },
    });
    expect(await compiled.check()).toBe(false);
  });

  it('env detector: fails when env var is an empty string', async () => {
    process.env.FLO_PREREQ_TEST_ENV = '';
    const compiled = compilePrerequisiteSpec({
      name: 'TEST_ENV',
      detect: { type: 'env', key: 'FLO_PREREQ_TEST_ENV' },
    });
    expect(await compiled.check()).toBe(false);
    delete process.env.FLO_PREREQ_TEST_ENV;
  });

  it('file detector: passes when file exists, fails when missing', async () => {
    const tmp = path.join(os.tmpdir(), `flo-prereq-${Date.now()}.txt`);
    await fsPromises.writeFile(tmp, 'x');
    try {
      const present = compilePrerequisiteSpec({
        name: 'CFG',
        detect: { type: 'file', path: tmp },
      });
      expect(await present.check()).toBe(true);
    } finally {
      await fsPromises.unlink(tmp);
    }

    const missing = compilePrerequisiteSpec({
      name: 'CFG',
      detect: { type: 'file', path: path.join(os.tmpdir(), 'flo-prereq-nonexistent-xyz') },
    });
    expect(await missing.check()).toBe(false);
  });

  it('command detector: fails when command is not on PATH', async () => {
    const compiled = compilePrerequisiteSpec({
      name: 'UNICORN',
      detect: { type: 'command', command: 'this-command-definitely-does-not-exist-xyz-460' },
    });
    expect(await compiled.check()).toBe(false);
    expect(compiled.envKey).toBeUndefined();
  });

  it('defaults promptOnMissing to true, url passes through from docsUrl', () => {
    const compiled = compilePrerequisiteSpec({
      name: 'X',
      docsUrl: 'https://docs.example',
      detect: { type: 'env', key: 'X' },
    });
    expect(compiled.promptOnMissing).toBe(true);
    expect(compiled.url).toBe('https://docs.example');
  });

  it('respects explicit promptOnMissing=false', () => {
    const compiled = compilePrerequisiteSpec({
      name: 'X',
      promptOnMissing: false,
      detect: { type: 'env', key: 'X' },
    });
    expect(compiled.promptOnMissing).toBe(false);
  });
});

// ============================================================================
// collectPrerequisites — YAML + step + nested walker (#460)
// ============================================================================

describe('collectPrerequisites — YAML walker', () => {
  it('picks up spell-level YAML prereqs', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));
    const def: SpellDefinition = {
      name: 'x',
      prerequisites: [{ name: 'TOK', detect: { type: 'env', key: 'TOK' } }],
      steps: [{ id: 's1', type: 'bash', config: {} }],
    };
    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs.map(p => p.name)).toContain('TOK');
    expect(prereqs.find(p => p.name === 'TOK')!.envKey).toBe('TOK');
  });

  it('picks up step-level YAML prereqs', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));
    const def: SpellDefinition = {
      name: 'x',
      steps: [{
        id: 's1', type: 'bash', config: {},
        prerequisites: [{ name: 'GH', detect: { type: 'command', command: 'gh' } }],
      }],
    };
    expect(collectPrerequisites(def, registry).map(p => p.name)).toEqual(['GH']);
  });

  it('walks nested loop/condition/parallel step bodies', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('loop'));
    registry.register(makeCommand('bash'));
    const def: SpellDefinition = {
      name: 'x',
      steps: [{
        id: 'outer', type: 'loop', config: {},
        steps: [{
          id: 'inner', type: 'bash', config: {},
          prerequisites: [{ name: 'NESTED', detect: { type: 'env', key: 'NESTED' } }],
        }],
      }],
    };
    expect(collectPrerequisites(def, registry).map(p => p.name)).toContain('NESTED');
  });

  it('dedupes across spell + step + step-command built-in (first wins)', () => {
    const registry = new StepCommandRegistry();
    const builtin = makePrereq('SHARED', true, 'builtin-hint');
    registry.register(makeCommand('github', [builtin]));

    const spellSpec: PrerequisiteSpec = {
      name: 'SHARED',
      description: 'spell-level',
      detect: { type: 'env', key: 'SHARED' },
    };
    const def: SpellDefinition = {
      name: 'x',
      prerequisites: [spellSpec],
      steps: [{ id: 's1', type: 'github', config: {} }],
    };

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(1);
    // Spell-level declaration wins (compiled from the YAML spec)
    expect(prereqs[0].description).toBe('spell-level');
    expect(prereqs[0].installHint).toBe('spell-level');
    expect(prereqs[0].envKey).toBe('SHARED');
  });
});

// ============================================================================
// resolveUnmetPrerequisites — prompt + fail-fast (#460)
// ============================================================================

describe('resolveUnmetPrerequisites', () => {
  const ENV_KEY = 'FLO_RESOLVE_TEST_460';

  beforeEach(() => { delete process.env[ENV_KEY]; });

  it('returns ok immediately when every prereq is satisfied', async () => {
    const result = await resolveUnmetPrerequisites([makePrereq('ok', true)], {
      interactive: false,
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedNames).toEqual([]);
  });

  it('non-TTY path: fails fast with a report listing every unmet prereq', async () => {
    const prereqs: Prerequisite[] = [
      compilePrerequisiteSpec({
        name: 'TOK_A',
        docsUrl: 'https://a.example',
        detect: { type: 'env', key: 'TOK_A_460' },
      }),
      compilePrerequisiteSpec({
        name: 'TOK_B',
        docsUrl: 'https://b.example',
        detect: { type: 'env', key: 'TOK_B_460' },
      }),
    ];
    const result = await resolveUnmetPrerequisites(prereqs, { interactive: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('TOK_A');
    expect(result.message).toContain('TOK_B');
    expect(result.message).toContain('https://a.example');
    expect(result.message).toContain('https://b.example');
  });

  it('TTY path: prompts for unmet env prereq and writes answer into process.env', async () => {
    const spec: PrerequisiteSpec = {
      name: 'GRAPH_TOKEN',
      description: 'Graph token',
      docsUrl: 'https://graph.example',
      detect: { type: 'env', key: ENV_KEY },
      promptOnMissing: true,
    };
    const prereq = compilePrerequisiteSpec(spec);
    const promptLine = vi.fn<PromptLineFn>(async () => 'provided-value');
    const logged: string[] = [];
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: (l) => logged.push(l),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedNames).toEqual(['GRAPH_TOKEN']);
    expect(process.env[ENV_KEY]).toBe('provided-value');
    expect(promptLine).toHaveBeenCalledTimes(1);
    expect(logged.some(l => l.includes('Preflight'))).toBe(true);
    expect(logged.some(l => l.includes('Graph token'))).toBe(true);
    expect(logged.some(l => l.includes('https://graph.example'))).toBe(true);
  });

  it('TTY path: empty answer fails with "was not provided"', async () => {
    const prereq = compilePrerequisiteSpec({
      name: 'X',
      detect: { type: 'env', key: ENV_KEY },
    });
    const promptLine = vi.fn<PromptLineFn>(async () => '');
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('was not provided');
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('command-type unmet prereq with no promptable partner fails fast even on TTY', async () => {
    const prereq = compilePrerequisiteSpec({
      name: 'UNICORN_CLI',
      detect: { type: 'command', command: 'this-command-does-not-exist-xyz-460' },
    });
    const promptLine = vi.fn<PromptLineFn>(async () => 'ignored');
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('UNICORN_CLI');
    expect(promptLine).not.toHaveBeenCalled();
  });

  it('does not prompt when promptOnMissing is explicitly false', async () => {
    const prereq = compilePrerequisiteSpec({
      name: 'OPT_OUT',
      promptOnMissing: false,
      detect: { type: 'env', key: ENV_KEY },
    });
    const promptLine = vi.fn<PromptLineFn>(async () => 'ignored');
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(promptLine).not.toHaveBeenCalled();
  });

  it('aborts mid-prompt when abortSignal fires', async () => {
    const controller = new AbortController();
    const prereq = compilePrerequisiteSpec({
      name: 'X',
      detect: { type: 'env', key: ENV_KEY },
    });
    const promptLine: PromptLineFn = async (_line, signal) => {
      controller.abort();
      if (signal?.aborted) throw new Error('Prompt aborted');
      return '';
    };
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      abortSignal: controller.signal,
      log: () => {},
    });
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// OAP retrofit (#518) — outlook-attachment-processor.yaml end-to-end
// ============================================================================
//
// Acceptance criteria from issue #518:
//   - Both tokens are declared as spell-level `prerequisites:`.
//   - The four hand-rolled preflight steps are removed.
//   - Casting on a non-TTY without env vars fails fast with BOTH tokens listed
//     and both docs URLs present in the error report (no partial run).

describe('OAP spell retrofit (#518)', () => {
  // Walk up from this test file until we find the repo root (where `spells/`
  // lives). Avoids hard-coding ../ counts, which drift if the test file moves.
  const here = path.dirname(fileURLToPath(import.meta.url));
  function findOapPath(): string {
    let dir = here;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, 'spells', 'dev', 'outlook-attachment-processor.yaml');
      try {
        accessSync(candidate);
        return candidate;
      } catch {
        // keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`Cannot locate spells/dev/outlook-attachment-processor.yaml above ${here}`);
  }
  const oapPath = findOapPath();

  async function loadOap(): Promise<SpellDefinition> {
    const yaml = await fsPromises.readFile(oapPath, 'utf8');
    const parsed = parseSpell(yaml, oapPath);
    return parsed.definition;
  }

  it('parses + validates with both prerequisites declared at spell level', async () => {
    const def = await loadOap();
    const result = validateSpellDefinition(def);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    const prereqNames = (def.prerequisites ?? []).map(p => p.name);
    expect(prereqNames).toEqual(['GRAPH_ACCESS_TOKEN', 'SLACK_WEBHOOK_URL']);
  });

  it('has no hand-rolled preflight steps (env-graph/ask-graph-token/env-slack/ask-slack-url)', async () => {
    const def = await loadOap();
    const stepIds = def.steps.map(s => s.id);
    expect(stepIds).not.toContain('env-graph');
    expect(stepIds).not.toContain('ask-graph-token');
    expect(stepIds).not.toContain('env-slack');
    expect(stepIds).not.toContain('ask-slack-url');
  });

  it('non-TTY without env vars fails fast with both tokens + docs URLs', async () => {
    const prevGraph = process.env.GRAPH_ACCESS_TOKEN;
    const prevSlack = process.env.SLACK_WEBHOOK_URL;
    delete process.env.GRAPH_ACCESS_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const def = await loadOap();
      const prereqs = (def.prerequisites ?? []).map(compilePrerequisiteSpec);
      const result = await resolveUnmetPrerequisites(prereqs, { interactive: false });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('GRAPH_ACCESS_TOKEN');
      expect(result.message).toContain('SLACK_WEBHOOK_URL');
      expect(result.message).toContain('https://developer.microsoft.com/en-us/graph/graph-explorer');
      expect(result.message).toContain('https://api.slack.com/messaging/webhooks');
    } finally {
      if (prevGraph !== undefined) process.env.GRAPH_ACCESS_TOKEN = prevGraph;
      if (prevSlack !== undefined) process.env.SLACK_WEBHOOK_URL = prevSlack;
    }
  });

  it('with both env vars set, preflight passes without prompting', async () => {
    const prevGraph = process.env.GRAPH_ACCESS_TOKEN;
    const prevSlack = process.env.SLACK_WEBHOOK_URL;
    process.env.GRAPH_ACCESS_TOKEN = 'test-graph-token';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    try {
      const def = await loadOap();
      const prereqs = (def.prerequisites ?? []).map(compilePrerequisiteSpec);
      const promptLine = vi.fn<PromptLineFn>(async () => 'unreachable');
      const result = await resolveUnmetPrerequisites(prereqs, {
        interactive: true,
        promptLine,
        log: () => {},
      });
      expect(result.ok).toBe(true);
      expect(result.resolvedNames).toEqual([]);
      expect(promptLine).not.toHaveBeenCalled();
    } finally {
      if (prevGraph === undefined) delete process.env.GRAPH_ACCESS_TOKEN;
      else process.env.GRAPH_ACCESS_TOKEN = prevGraph;
      if (prevSlack === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = prevSlack;
    }
  });
});
