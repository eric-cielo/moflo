/**
 * Shared test helpers for spell tests.
 */

import type {
  StepCommand,
  StepConfig,
  CastingContext,
  CredentialAccessor,
  MemoryAccessor,
} from '../../spells/types/step-command.types.js';
import type { ICapabilityGateway } from '../../spells/core/capability-gateway.js';

/** Allow-all gateway for tests — no capability is denied. */
export const ALLOW_ALL_GATEWAY: ICapabilityGateway = {
  checkNet() {},
  checkShell() {},
  checkFsRead() {},
  checkFsWrite() {},
  checkAgent() {},
  checkMemory() {},
  checkBrowser() {},
  checkBrowserEvaluate() {},
  checkCredentials() {},
};
import type { StepDefinition } from '../../spells/types/spell-definition.types.js';
import type { SpellResult } from '../../spells/types/runner.types.js';

export function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return { id: 'test-step', type: 'bash', config: { command: 'echo hello' }, ...overrides };
}

export function makeCommand(overrides: Partial<StepCommand> = {}): StepCommand {
  return {
    type: 'test',
    description: 'test command',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: {} }),
    describeOutputs: () => [],
    ...overrides,
  };
}

export function makeCredentials(store: Record<string, string> = {}): CredentialAccessor {
  return {
    async get(name: string) { return store[name]; },
    async has(name: string) { return name in store; },
  };
}

export function makeMemory(): MemoryAccessor {
  const data = new Map<string, unknown>();
  return {
    async read(ns: string, key: string) { return data.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) { data.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

export function getStdout(result: SpellResult, stepId: string): string {
  const output = result.outputs[stepId] as Record<string, unknown> | undefined;
  return ((output?.stdout as string) ?? '').trim();
}

export function createMockContext(overrides?: Partial<CastingContext>): CastingContext {
  return {
    variables: {},
    args: {},
    credentials: makeCredentials(),
    memory: makeMemory(),
    taskId: 'test',
    spellId: 'wf-1',
    stepIndex: 0,
    gateway: ALLOW_ALL_GATEWAY,
    ...overrides,
  };
}
