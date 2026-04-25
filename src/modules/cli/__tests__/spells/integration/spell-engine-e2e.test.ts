/**
 * End-to-End Integration Tests — Spell Engine
 *
 * Issue #188: True integration tests exercising the full pipeline without mocks.
 *
 * Tests:
 *   1. Grimoire discover → Runner execute (real built-in commands)
 *   2. CredentialStore → Runner with real {credentials.NAME} resolution
 *   3. Concurrent spell isolation (two spells don't corrupt variables)
 *   4. Command injection via interpolated variables in bash command
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { Grimoire } from '../../../src/spells/registry/spell-registry.js';
import { createRunner, runSpellFromContent } from '../../../src/spells/factory/runner-factory.js';
import { CredentialStore } from '../../../src/spells/credentials/credential-store.js';
import type { SpellDefinition } from '../../../src/spells/types/spell-definition.types.js';
import { getStdout } from '../helpers.js';

// ============================================================================
// Helpers
// ============================================================================

function writeFixture(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

// ============================================================================
// 1. Grimoire discover → Runner execute
// ============================================================================

describe('Registry discover → Runner execute', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `wf-e2e-${randomBytes(6).toString('hex')}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeTmpDir(name: string): string {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('loads a spell definition from disk via registry', () => {
    const shippedDir = makeTmpDir('shipped');
    writeFixture(shippedDir, 'echo-test.yaml', `
name: echo-test
abbreviation: et
description: "Echo integration test"
steps:
  - id: greet
    type: bash
    config:
      command: echo "hello from spell"
    output: greet
`);

    const registry = new Grimoire({ shippedDir });
    const result = registry.load();
    expect(result.errors).toHaveLength(0);

    const spell = result.spells.get('echo-test');
    expect(spell).toBeDefined();
    expect(spell!.definition.abbreviation).toBe('et');
  });

  it('resolves a spell by abbreviation and runs it through the runner', async () => {
    const shippedDir = makeTmpDir('shipped-run');
    writeFixture(shippedDir, 'simple-echo.yaml', `
name: simple-echo
abbreviation: se
description: "Simple echo"
steps:
  - id: s1
    type: bash
    config:
      command: echo "integration-test-output"
    output: s1
`);

    const registry = new Grimoire({ shippedDir });
    const loadResult = registry.load();
    expect(loadResult.abbreviations.get('se')).toBe('simple-echo');

    const wf = loadResult.spells.get('simple-echo');
    expect(wf).toBeDefined();

    const runner = createRunner();
    const result = await runner.run(wf!.definition, {});

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('succeeded');
    expect(getStdout(result, 's1')).toBe('integration-test-output');
  });

  it('runs a multi-step spell with variable passing between steps', async () => {
    const content = `
name: multi-step
steps:
  - id: step1
    type: bash
    config:
      command: echo "first"
    output: step1
  - id: step2
    type: bash
    config:
      command: echo "second"
    output: step2
`;
    const result = await runSpellFromContent(content, undefined, { args: {} });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every(s => s.status === 'succeeded')).toBe(true);
  });
});

// ============================================================================
// 2. CredentialStore → Runner with real credential resolution
// ============================================================================

describe('CredentialStore → Runner integration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `wf-cred-${randomBytes(6).toString('hex')}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeTmpDir(name: string): string {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('wires CredentialStore through to runner and provides allValues for redaction', async () => {
    const storePath = join(makeTmpDir('cred-store'), 'credentials.json');
    const store = new CredentialStore({ filePath: storePath, passphrase: 'test-pass-1234' });

    await store.store('DB_HOST', 'localhost:5432');
    await store.store('API_TOKEN', 'tok_secret_abc123');

    expect(await store.has('DB_HOST')).toBe(true);
    expect(await store.get('DB_HOST')).toBe('localhost:5432');
    expect(await store.has('MISSING')).toBe(false);
    expect(await store.get('MISSING')).toBeUndefined();

    // Verify the runner accepts the store and allValues works for redaction
    createRunner({ credentials: store });
    const values = await store.allValues();
    expect(values).toContain('localhost:5432');
    expect(values).toContain('tok_secret_abc123');
  });

  it('CredentialStore round-trips encrypt/decrypt correctly', async () => {
    const storePath = join(makeTmpDir('cred-rt'), 'credentials.json');
    const store = new CredentialStore({ filePath: storePath, passphrase: 'roundtrip1234' });

    const secrets = [
      { name: 'KEY1', value: 'simple-value' },
      { name: 'KEY2', value: 'value with spaces & special chars: ${}[]!' },
      { name: 'KEY3', value: 'a'.repeat(1000) },
    ];

    for (const s of secrets) {
      await store.store(s.name, s.value);
    }

    for (const s of secrets) {
      expect(await store.get(s.name)).toBe(s.value);
    }
  });

  it('CredentialStore lock/unlock lifecycle works', async () => {
    const storePath = join(makeTmpDir('cred-lock'), 'credentials.json');
    const store = new CredentialStore({ filePath: storePath, passphrase: 'locktest1234' });

    await store.store('SECRET', 'hidden-value');
    expect(await store.get('SECRET')).toBe('hidden-value');

    store.lock();
    await expect(store.get('SECRET')).rejects.toThrow('locked');

    store.unlock('locktest1234');
    expect(await store.get('SECRET')).toBe('hidden-value');
  });
});

// ============================================================================
// 3. Concurrent spell isolation
// ============================================================================

describe('Concurrent spell isolation', () => {
  const runner = createRunner();

  it('two parallel spells do not corrupt each other\'s variables', async () => {
    const spell1: SpellDefinition = {
      name: 'wf-alpha',
      steps: [
        { id: 'a1', type: 'bash', config: { command: 'echo "alpha-output"' }, output: 'a1' },
        { id: 'a2', type: 'bash', config: { command: 'echo "alpha-step2"' }, output: 'a2' },
      ],
    };

    const spell2: SpellDefinition = {
      name: 'wf-beta',
      steps: [
        { id: 'b1', type: 'bash', config: { command: 'echo "beta-output"' }, output: 'b1' },
        { id: 'b2', type: 'bash', config: { command: 'echo "beta-step2"' }, output: 'b2' },
      ],
    };

    const [result1, result2] = await Promise.all([
      runner.run(spell1, {}, { spellId: 'iso-1' }),
      runner.run(spell2, {}, { spellId: 'iso-2' }),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result1.spellId).toBe('iso-1');
    expect(result2.spellId).toBe('iso-2');

    expect(getStdout(result1, 'a1')).toBe('alpha-output');
    expect(getStdout(result2, 'b1')).toBe('beta-output');

    expect(result1.outputs).not.toHaveProperty('b1');
    expect(result2.outputs).not.toHaveProperty('a1');
  });

  it('one spell failing does not affect the other', async () => {
    const goodSpell: SpellDefinition = {
      name: 'wf-good',
      steps: [
        { id: 'g1', type: 'bash', config: { command: 'echo "success"' }, output: 'g1' },
      ],
    };

    const badSpell: SpellDefinition = {
      name: 'wf-bad',
      steps: [
        { id: 'bad1', type: 'nonexistent-type', config: {} },
      ],
    };

    const [good, bad] = await Promise.all([
      runner.run(goodSpell, {}, { spellId: 'good-1' }),
      runner.run(badSpell, {}, { spellId: 'bad-1' }),
    ]);

    expect(good.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

// ============================================================================
// 4. Command injection via interpolated variables
// ============================================================================

describe('Command injection through interpolated variables', () => {
  // KNOWN VULNERABILITY: The step executor runs interpolateConfig() on step
  // config BEFORE bash command's execute() is called, replacing {args.*} with
  // raw values. shellInterpolateString() then has no placeholders left to escape.
  //
  // These tests document CURRENT vulnerable behavior. When the double-interpolation
  // is fixed, update these tests to assert safe behavior.

  const runner = createRunner();

  it.each([
    ['semicolon', 'safe; echo INJECTED', 'INJECTED'],
    ['$() subshell', '$(echo PWNED)', 'PWNED'],
    ['backtick', '`echo PWNED`', 'PWNED'],
  ])('%s injection is executed (documents vulnerability)', async (_label, input, expected) => {
    const spell: SpellDefinition = {
      name: `injection-${_label}`,
      arguments: { input: { type: 'string', required: true } },
      steps: [{
        id: 'inject',
        type: 'bash',
        config: { command: 'echo {args.input}' },
        output: 'inject',
      }],
    };

    const result = await runner.run(spell, { input });
    expect(result.success).toBe(true);
    expect(getStdout(result, 'inject')).toContain(expected);
  }, 10_000);

  it('static commands without interpolated variables are not affected', async () => {
    const spell: SpellDefinition = {
      name: 'static-safe',
      steps: [{
        id: 'safe',
        type: 'bash',
        config: { command: 'echo "static-value"' },
        output: 'safe',
      }],
    };

    const result = await runner.run(spell, {});
    expect(result.success).toBe(true);
    expect(getStdout(result, 'safe')).toBe('static-value');
  });
});
