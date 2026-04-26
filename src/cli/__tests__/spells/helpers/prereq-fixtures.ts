/**
 * Shared fixtures for prerequisite-checker tests.
 *
 * Consumed by prerequisites-registry, prerequisites-spec,
 * prerequisites-resolve, and prerequisites-integration test files.
 */

import { vi } from 'vitest';
import type {
  StepCommand,
  Prerequisite,
  CredentialAccessor,
  MemoryAccessor,
} from '../../../spells/types/step-command.types.js';
import type { SpellDefinition } from '../../../spells/types/spell-definition.types.js';

export function makePrereq(
  name: string,
  satisfied: boolean,
  hint = `Install ${name}`,
): Prerequisite {
  return {
    name,
    check: vi.fn(async () => satisfied),
    installHint: hint,
    url: `https://example.com/${name}`,
  };
}

export function makeCommand(type: string, prereqs?: readonly Prerequisite[]): StepCommand {
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

export function simpleSpell(steps: SpellDefinition['steps']): SpellDefinition {
  return { name: 'test', steps };
}

export function createMockCredentials(): CredentialAccessor {
  return {
    async get() { return undefined; },
    async has() { return false; },
  };
}

export function createMockMemory(): MemoryAccessor {
  const store = new Map<string, unknown>();
  return {
    async read(ns: string, key: string) { return store.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) { store.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

/**
 * Run `fn` with the given env vars set (or deleted if the value is undefined),
 * restoring every touched key on exit regardless of how `fn` resolves. Avoids
 * the 4-branch save/delete/restore ceremony that's easy to get wrong.
 */
export async function withEnvVars<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const next = overrides[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}
