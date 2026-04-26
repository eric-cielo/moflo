/**
 * Preflight Severity Tests
 *
 * Verifies fatal vs warning behavior, handler invocation, and resolution
 * command execution when a warning-severity preflight fails.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpellCaster } from '../../spells/core/runner.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import type {
  StepCommand,
  CredentialAccessor,
  MemoryAccessor,
} from '../../spells/types/step-command.types.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import type {
  PreflightWarning,
  PreflightWarningDecision,
} from '../../spells/types/runner.types.js';

function createMockCredentials(): CredentialAccessor {
  return { async get() { return undefined; }, async has() { return false; } };
}

function createMockMemory(): MemoryAccessor {
  const store = new Map<string, unknown>();
  return {
    async read(ns: string, key: string) { return store.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) { store.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

function bashCommand(): StepCommand {
  return {
    type: 'bash',
    description: 'mock bash',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: { result: 'ok' }, duration: 1 }),
    describeOutputs: () => [{ name: 'result', type: 'string' }],
  };
}

function makeRunner(): SpellCaster {
  const registry = new StepCommandRegistry();
  registry.register(bashCommand());
  return new SpellCaster(registry, createMockCredentials(), createMockMemory());
}

const alwaysFailCmd = process.platform === 'win32' ? 'exit 1' : 'false';
const alwaysPassCmd = process.platform === 'win32' ? 'exit 0' : 'true';

function spellWith(preflight: SpellDefinition['steps'][0]['preflight']): SpellDefinition {
  return {
    name: 'severity-test',
    steps: [{ id: 's1', type: 'bash', config: { command: 'echo ok' }, preflight }],
  };
}

describe('preflight severity', () => {
  it('fatal failure aborts spell with PREFLIGHT_FAILED (default severity)', async () => {
    const result = await makeRunner().run(
      spellWith([{ name: 'must-pass', command: alwaysFailCmd, hint: 'nope' }]),
      {},
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFLIGHT_FAILED');
  });

  it('warning failure without handler is treated as fatal', async () => {
    const result = await makeRunner().run(
      spellWith([{
        name: 'soft',
        command: alwaysFailCmd,
        severity: 'warning',
        hint: 'soft problem',
      }]),
      {},
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFLIGHT_FAILED');
  });

  it('warning failure with handler calls handler with warning payload', async () => {
    const handler = vi.fn(async (_warnings: readonly PreflightWarning[]) => {
      return [{ action: 'continue' }] as readonly PreflightWarningDecision[];
    });
    const result = await makeRunner().run(
      spellWith([{
        name: 'soft',
        command: alwaysFailCmd,
        severity: 'warning',
        hint: 'soft problem',
        resolutions: [{ label: 'Skip it' }],
      }]),
      {},
      { onPreflightWarnings: handler },
    );
    expect(handler).toHaveBeenCalledOnce();
    const [warnings] = handler.mock.calls[0];
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('soft problem');
    expect(warnings[0].resolutions).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it('handler decision "abort" aborts the spell', async () => {
    const result = await makeRunner().run(
      spellWith([{ name: 'soft', command: alwaysFailCmd, severity: 'warning' }]),
      {},
      { onPreflightWarnings: async () => [{ action: 'abort' }] },
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFLIGHT_FAILED');
  });

  it('handler decision "resolve" runs the chosen resolution command', async () => {
    const result = await makeRunner().run(
      spellWith([{
        name: 'soft',
        command: alwaysFailCmd,
        severity: 'warning',
        resolutions: [{ label: 'fix', command: alwaysPassCmd }],
      }]),
      {},
      { onPreflightWarnings: async () => [{ action: 'resolve', resolutionIndex: 0 }] },
    );
    expect(result.success).toBe(true);
  });

  it('resolution command failure aborts with a clear message', async () => {
    const result = await makeRunner().run(
      spellWith([{
        name: 'soft',
        command: alwaysFailCmd,
        severity: 'warning',
        resolutions: [{ label: 'fix', command: alwaysFailCmd }],
      }]),
      {},
      { onPreflightWarnings: async () => [{ action: 'resolve', resolutionIndex: 0 }] },
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREFLIGHT_FAILED');
    expect(result.errors[0].message).toMatch(/Resolution "fix" failed/);
  });

  it('fatal + warning together: fatal aborts before handler is called', async () => {
    const handler = vi.fn(async () => [{ action: 'continue' }] as readonly PreflightWarningDecision[]);
    const result = await makeRunner().run(
      spellWith([
        { name: 'hard', command: alwaysFailCmd, hint: 'hard-fail' },
        { name: 'soft', command: alwaysFailCmd, severity: 'warning' },
      ]),
      {},
      { onPreflightWarnings: handler },
    );
    expect(result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid resolution index aborts with an error', async () => {
    const result = await makeRunner().run(
      spellWith([{
        name: 'soft',
        command: alwaysFailCmd,
        severity: 'warning',
        resolutions: [{ label: 'fix', command: alwaysPassCmd }],
      }]),
      {},
      { onPreflightWarnings: async () => [{ action: 'resolve', resolutionIndex: 5 }] },
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/Invalid resolution index/);
  });

  it('handler that returns wrong decision count aborts', async () => {
    const result = await makeRunner().run(
      spellWith([
        { name: 'w1', command: alwaysFailCmd, severity: 'warning' },
        { name: 'w2', command: alwaysFailCmd, severity: 'warning' },
      ]),
      {},
      { onPreflightWarnings: async () => [{ action: 'continue' }] },
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/returned 1 decisions for 2 warnings/);
  });
});
