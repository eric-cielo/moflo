/**
 * Runner-level tests for the auth-error recovery hook (#1042).
 *
 * Covers the three documented surfaces of the recovery path:
 *  - Non-TTY without host hook → step failure is rewritten to
 *    `CREDENTIAL_LIKELY_STALE` so schedulers can route to humans.
 *  - Confirm=true → store cleared, prereqs re-resolved, step retried once
 *    and the new result replaces the original.
 *  - Confirm=true but the retry hits the same auth shape → second-failure
 *    short-circuit (no infinite loop).
 *  - Confirm=false → original failure carried forward unchanged.
 *  - Auth-shaped error but no env-keyed prereqs → not matched (nothing to
 *    clear, no recovery, original failure carried forward).
 *
 * The TTY path is exercised via `RunnerOptions.authErrorConfirm`, the
 * test/host hook added alongside the recovery code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpellCaster } from '../../spells/core/runner.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import type {
  StepCommand,
  CredentialAccessor,
  MemoryAccessor,
} from '../../spells/types/step-command.types.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import { withEnvVars } from './helpers/prereq-fixtures.js';

// ============================================================================
// Mocks
// ============================================================================

interface MockCredentialAccessor extends CredentialAccessor {
  getCalls: string[];
  deleteCalls: string[];
  storeCalls: Array<{ name: string; value: string }>;
}

function makeMockCredentials(initial: Record<string, string> = {}): MockCredentialAccessor {
  const data = new Map<string, string>(Object.entries(initial));
  const accessor: MockCredentialAccessor = {
    getCalls: [],
    deleteCalls: [],
    storeCalls: [],
    async get(name: string) {
      accessor.getCalls.push(name);
      return data.get(name);
    },
    async has(name: string) { return data.has(name); },
    async store(name: string, value: string) {
      accessor.storeCalls.push({ name, value });
      data.set(name, value);
    },
    async delete(name: string) {
      accessor.deleteCalls.push(name);
      const had = data.has(name);
      data.delete(name);
      return had;
    },
  };
  return accessor;
}

function makeMemory(): MemoryAccessor {
  const store = new Map<string, unknown>();
  return {
    async read(ns: string, key: string) { return store.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) { store.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

/**
 * Build a step command that fails with `errorMessage` on attempts 1..N
 * and succeeds on attempt N+1. Tracks the actual attempt count so the
 * assertion can verify retry-once vs. no-retry.
 */
function makeFlakyAuthCommand(opts: {
  type?: string;
  failuresBeforeSuccess: number;
  errorMessage: string;
}): StepCommand & { calls: number } {
  const cmd = {
    type: opts.type ?? 'flaky-auth',
    description: 'flaky',
    configSchema: { type: 'object' as const },
    calls: 0,
    validate: () => ({ valid: true, errors: [] }),
    async execute() {
      cmd.calls++;
      if (cmd.calls <= opts.failuresBeforeSuccess) {
        return { success: false, data: {}, error: opts.errorMessage, duration: 1 };
      }
      return { success: true, data: { ok: true }, duration: 1 };
    },
    describeOutputs: () => [],
  } satisfies StepCommand & { calls: number };
  return cmd;
}

function spellWithCredPrereq(stepType: string): SpellDefinition {
  return {
    name: 'auth-recovery-test',
    prerequisites: [
      {
        name: 'GRAPH_ACCESS_TOKEN',
        detect: { type: 'env', key: 'GRAPH_ACCESS_TOKEN' },
        promptOnMissing: true,
      },
    ],
    steps: [{ id: 's1', type: stepType, config: {} }],
  };
}

function spellWithoutCredPrereq(stepType: string): SpellDefinition {
  return {
    name: 'no-cred-prereq-test',
    steps: [{ id: 's1', type: stepType, config: {} }],
  };
}

// ============================================================================
// Setup
// ============================================================================

let registry: StepCommandRegistry;

beforeEach(() => {
  registry = new StepCommandRegistry();
});

// ============================================================================
// Tests
// ============================================================================

describe('runner — auth-error recovery (issue #1042)', () => {
  it('rewrites step failure to CREDENTIAL_LIKELY_STALE in non-TTY when no host hook is supplied', async () => {
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: 'Graph 401: {"error":{"code":"InvalidAuthenticationToken","message":"IDX14100"}}',
    });
    registry.register(cmd);
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'opaque-stale-token' });
    const runner = new SpellCaster(registry, credentials, makeMemory());

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'opaque-stale-token' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd.type), {});
      expect(result.success).toBe(false);
      expect(result.steps[0].errorCode).toBe('CREDENTIAL_LIKELY_STALE');
      expect(result.steps[0].error).toMatch(/CREDENTIAL_LIKELY_STALE/);
      expect(result.steps[0].error).toMatch(/GRAPH_ACCESS_TOKEN/);
    });

    // No retry in non-TTY — the original IDX14100 attempt is the only call.
    expect(cmd.calls).toBe(1);
    // No delete invoked because the user never confirmed.
    expect(credentials.deleteCalls).toHaveLength(0);
  });

  it('retries successfully when the host hook confirms AND the user supplies a fresh credential', async () => {
    // The headline happy-path for #1042: step fails with stale token →
    // host confirms clearing → user re-supplies a working token → retry
    // succeeds. We simulate the user pasting a fresh token by having the
    // credentials accessor's `delete` re-populate with a working value
    // before `resolveUnmetPrerequisites` re-runs (mirroring the real flow
    // where the TTY prompt elicits a new token from the user).
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: 1,
      errorMessage: 'Graph 401: IDX14100 JWT not well formed',
    });
    registry.register(cmd);
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'stale' });
    const origDelete = credentials.delete!.bind(credentials);
    credentials.delete = async (name: string) => {
      const r = await origDelete(name);
      // Simulate the user pasting a new token in the resolver's prompt.
      await credentials.store(name, 'fresh-and-working-token');
      return r;
    };
    const runner = new SpellCaster(registry, credentials, makeMemory());

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'stale' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd.type), {}, {
        authErrorConfirm: async () => true,
      });

      // Two attempts, the second one succeeds with the fresh token.
      expect(cmd.calls).toBe(2);
      expect(credentials.deleteCalls).toEqual(['GRAPH_ACCESS_TOKEN']);
      expect(result.success).toBe(true);
      expect(result.steps[0].status).toBe('succeeded');
      // Env was restored from the fresh credential.
      expect(process.env.GRAPH_ACCESS_TOKEN).toBe('fresh-and-working-token');
    });
  });

  it('clears the credential and retries once when the host hook confirms (success on retry)', async () => {
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: 1,
      errorMessage: 'Slack 401: invalid_auth',
    });
    registry.register(cmd);
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'stale' });
    const runner = new SpellCaster(registry, credentials, makeMemory());

    const promptCalls: Array<{ stepId: string; pattern: string; credKeys: readonly string[] }> = [];
    const confirm = vi.fn(async (info: { stepId: string; pattern: string; reason: string; credKeys: readonly string[] }) => {
      promptCalls.push({ stepId: info.stepId, pattern: info.pattern, credKeys: info.credKeys });
      return true;
    });

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'stale' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd.type), {}, {
        authErrorConfirm: confirm,
        // Re-resolution path needs a non-interactive completion hook so the
        // test doesn't block on stdin. forceCredentialReprompt: true skips
        // the store-resolve step; the dummy env override below provides
        // the post-retry value.
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(promptCalls[0].stepId).toBe('s1');
      expect(promptCalls[0].credKeys).toEqual(['GRAPH_ACCESS_TOKEN']);

      // After confirm, the runner deletes the stored credential, but then
      // resolveUnmetPrerequisites must re-acquire one. With no TTY and no
      // promptLine override, this fails as MISSING_CREDENTIAL — the retry
      // path then reports CREDENTIAL_LIKELY_STALE with the after-reprompt
      // suffix. The credential WAS cleared, the hook WAS called once.
      expect(credentials.deleteCalls).toEqual(['GRAPH_ACCESS_TOKEN']);
      expect(result.success).toBe(false);
      expect(result.steps[0].errorCode).toBe('CREDENTIAL_LIKELY_STALE');
      expect(result.steps[0].error).toMatch(/manual intervention required|Re-prompt accepted/);
    });
  });

  it('short-circuits on second auth-shape failure after re-prompt (no infinite retry)', async () => {
    // Pre-populate process.env so the first prereq resolution succeeds, and
    // simulate the post-clear re-resolve via a host that re-injects a value
    // through the credentials accessor.
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: 'Graph 401: IDX14100 JWT not well formed',
    });
    registry.register(cmd);

    // The accessor's "store" populates data so the resolveUnmetPrerequisites
    // re-resolve path can pull the new value out of the store.
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'stale' });
    // Make the host re-inject the token into the store between the clear
    // and the retry by intercepting `delete`. After delete, the next get
    // returns a fresh value so re-resolution succeeds and the step retries.
    const origDelete = credentials.delete!.bind(credentials);
    credentials.delete = async (name: string) => {
      const r = await origDelete(name);
      // Simulate user pasting a new value into the store before re-resolve.
      await credentials.store(name, 'fresh-token-still-broken-upstream');
      // Also keep process.env consistent with the freshly-stored value.
      process.env[name] = 'fresh-token-still-broken-upstream';
      return r;
    };

    const runner = new SpellCaster(registry, credentials, makeMemory());

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'stale' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd.type), {}, {
        authErrorConfirm: async () => true,
      });

      // First call → fails with IDX14100 → confirm true → delete + reinject
      // → retry → second call → fails with IDX14100 again → SHORT-CIRCUIT.
      expect(cmd.calls).toBe(2);
      expect(result.success).toBe(false);
      expect(result.steps[0].errorCode).toBe('CREDENTIAL_LIKELY_STALE');
      expect(result.steps[0].error).toMatch(/manual intervention required/);
    });
  });

  it('carries the original failure forward when the host hook returns false', async () => {
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: '{"message":"Bad credentials","status":401}',
    });
    registry.register(cmd);
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'stored' });
    const runner = new SpellCaster(registry, credentials, makeMemory());

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'stored' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd.type), {}, {
        authErrorConfirm: async () => false,
      });

      expect(cmd.calls).toBe(1); // no retry
      expect(credentials.deleteCalls).toHaveLength(0);
      expect(result.success).toBe(false);
      // Original failure preserved — error code is the standard step
      // execution failed code, not CREDENTIAL_LIKELY_STALE.
      expect(result.steps[0].errorCode).toBe('STEP_EXECUTION_FAILED');
    });
  });

  it('does not trigger recovery when the spell has no env-keyed prereqs even if the error matches', async () => {
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: 'HTTP 401: invalid token',
    });
    registry.register(cmd);
    const confirm = vi.fn(async () => true);
    const credentials = makeMockCredentials();
    const runner = new SpellCaster(registry, credentials, makeMemory());

    const result = await runner.run(spellWithoutCredPrereq(cmd.type), {}, {
      authErrorConfirm: confirm,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(cmd.calls).toBe(1);
    expect(result.steps[0].errorCode).toBe('STEP_EXECUTION_FAILED');
  });

  it('skips recovery for low-confidence patterns (HTTP 403, bare Unauthorized)', async () => {
    // Issue #1042 reviewer caught this: HTTP 403 typically means "wrong
    // scope" not "stale credential", and bare "Unauthorized" appears in
    // many unrelated 4xx responses. Clearing on those would trash a working
    // credential, so we only auto-prompt on high-confidence matches.
    const cmd403 = makeFlakyAuthCommand({
      type: 'flaky-403',
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: 'HTTP 403: forbidden — missing scope',
    });
    registry.register(cmd403);
    const confirm = vi.fn(async () => true);
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'still-good' });
    const runner = new SpellCaster(registry, credentials, makeMemory());

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'still-good' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd403.type), {}, {
        authErrorConfirm: confirm,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(credentials.deleteCalls).toHaveLength(0);
      expect(cmd403.calls).toBe(1);
      // Low-confidence match falls through to the original failure path.
      expect(result.steps[0].errorCode).toBe('STEP_EXECUTION_FAILED');
    });
  });

  it('flips the prompt default to N when multiple env-keyed prereqs are in scope', async () => {
    // Issue #1042 reviewer caught this: clearing every credential when only
    // one is stale would replace a working credential with whatever the
    // user types next. Single-cred default is Y (the OAP case from the
    // issue body); multi-cred default flips to N so a stray Enter doesn't
    // wipe a credential that wasn't the one upstream rejected.
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: 'Graph 401: IDX14100',
    });
    registry.register(cmd);
    const credentials = makeMockCredentials({
      GRAPH_ACCESS_TOKEN: 'graph-stale',
      SLACK_TOKEN: 'slack-still-good',
    });
    const runner = new SpellCaster(registry, credentials, makeMemory());

    const definition: SpellDefinition = {
      name: 'multi-cred',
      prerequisites: [
        { name: 'GRAPH_ACCESS_TOKEN', detect: { type: 'env', key: 'GRAPH_ACCESS_TOKEN' }, promptOnMissing: true },
        { name: 'SLACK_TOKEN', detect: { type: 'env', key: 'SLACK_TOKEN' }, promptOnMissing: true },
      ],
      steps: [{ id: 's1', type: cmd.type, config: {} }],
    };

    let receivedKeys: readonly string[] | null = null;
    const confirm = vi.fn(async (info: { credKeys: readonly string[] }) => {
      receivedKeys = info.credKeys;
      return false; // user declines — we just want to verify both keys reach the prompt
    });

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'graph-stale', SLACK_TOKEN: 'slack-still-good' }, async () => {
      const result = await runner.run(definition, {}, { authErrorConfirm: confirm });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(receivedKeys).toEqual(['GRAPH_ACCESS_TOKEN', 'SLACK_TOKEN']);
      // User said no — neither credential was touched.
      expect(credentials.deleteCalls).toHaveLength(0);
      expect(result.steps[0].errorCode).toBe('STEP_EXECUTION_FAILED');
    });
  });

  it('does not trigger recovery for a non-auth error even when creds exist', async () => {
    const cmd = makeFlakyAuthCommand({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      errorMessage: 'ETIMEDOUT: connect timeout after 5000ms',
    });
    registry.register(cmd);
    const confirm = vi.fn(async () => true);
    const credentials = makeMockCredentials({ GRAPH_ACCESS_TOKEN: 'good' });
    const runner = new SpellCaster(registry, credentials, makeMemory());

    await withEnvVars({ GRAPH_ACCESS_TOKEN: 'good' }, async () => {
      const result = await runner.run(spellWithCredPrereq(cmd.type), {}, {
        authErrorConfirm: confirm,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(credentials.deleteCalls).toHaveLength(0);
      expect(result.steps[0].errorCode).toBe('STEP_EXECUTION_FAILED');
    });
  });
});
