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
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import { builtinCommands } from '../../spells/commands/index.js';
import { analyzeSpellPermissions } from '../../spells/core/permission-disclosure.js';
import { recordAcceptance } from '../../spells/core/permission-acceptance.js';

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

export function makeCredentials(initial: Record<string, string> = {}): CredentialAccessor & {
  readonly snapshot: Record<string, string>;
  readonly storeCalls: ReadonlyArray<readonly [string, string]>;
} {
  const data = { ...initial };
  const storeCalls: Array<[string, string]> = [];
  return {
    async get(name: string) { return data[name]; },
    async has(name: string) { return name in data; },
    async store(name: string, value: string) {
      storeCalls.push([name, value]);
      data[name] = value;
    },
    snapshot: data,
    storeCalls,
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

/**
 * A bash command that matches the runner's `claude -p` detection regex without
 * invoking a billed model: `echo` consumes the rest as literal arguments. Lets
 * a test assert both halves — that a permitted reservation really does spawn,
 * and that a denied one really does not.
 */
export const MODEL_SHAPED_COMMAND = 'echo claude -p hello';

/**
 * Record the permission acceptance a spell would have received at cast time.
 *
 * Any run given a `projectRoot` passes the first-run permission gate
 * (`runner.ts` keys it on `options.projectRoot`), and a spell with bash steps
 * is "higher risk" so it is not auto-accepted. Real spells are accepted once by
 * their owner; tests that fabricate definitions record it themselves.
 */
export async function preAcceptSpell(
  definition: SpellDefinition,
  projectRoot: string,
): Promise<void> {
  const registry = new StepCommandRegistry();
  for (const cmd of builtinCommands) registry.register(cmd, 'built-in');
  const report = analyzeSpellPermissions(definition, registry);
  await recordAcceptance(projectRoot, definition.name, report.permissionHash);
}
