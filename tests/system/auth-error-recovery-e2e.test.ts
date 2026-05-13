/**
 * System E2E: auth-error recovery end-to-end (#1042).
 *
 * Drives the spell runner against a *real* `CredentialStore` (an encrypted
 * file on disk in a tmpdir) and the real `resolveUnmetPrerequisites` flow,
 * not the unit-test mock. The point is to prove the production wiring
 * works as a system: stale credentials get cleared from the actual file,
 * the resolver re-resolves through the real chain, and the runner retries
 * the failing step with a fresh value.
 *
 * If any of the runner ↔ prerequisite-checker ↔ credential-store contract
 * regresses, this is where it shows up — not in the per-module unit tests.
 *
 * Scenarios, mirroring the AC merge gate from the issue body:
 *   1. Headline fix: stale token → confirm → fresh token → retry succeeds.
 *   2. Initial cast (no creds): existing MISSING_CREDENTIAL path unchanged.
 *   3. Happy path (valid stored creds): step succeeds, recovery never fires.
 *   4. Confirm declined: original failure carried forward, store untouched.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpellCaster } from '../../src/cli/spells/core/runner.js';
import { StepCommandRegistry } from '../../src/cli/spells/core/step-command-registry.js';
import {
  CredentialStore,
} from '../../src/cli/spells/credentials/credential-store.js';
import type {
  StepCommand,
  MemoryAccessor,
} from '../../src/cli/spells/types/step-command.types.js';
import type { SpellDefinition } from '../../src/cli/spells/types/spell-definition.types.js';
import { warmRunnerPipeline } from '../../src/cli/__tests__/spells/helpers/warm-runner.js';

// ============================================================================
// Test scaffolding
// ============================================================================

function makeMemory(): MemoryAccessor {
  const m = new Map<string, unknown>();
  return {
    async read(ns, key) { return m.get(`${ns}:${key}`) ?? null; },
    async write(ns, key, value) { m.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

interface FlakyAuth {
  command: StepCommand;
  /** Number of times execute() was invoked. */
  calls: () => number;
}

/**
 * Build a step command that fails with a Graph-style 401 on attempts
 * 1..N and then returns success on attempt N+1. Used to model the real
 * upstream behavior the recovery hook is designed to handle.
 */
function makeFlakyGraphCommand(failuresBeforeSuccess: number): FlakyAuth {
  let calls = 0;
  const command: StepCommand = {
    type: 'graph-flaky',
    description: 'Simulates Graph 401 on stale token',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    async execute() {
      calls++;
      if (calls <= failuresBeforeSuccess) {
        return {
          success: false,
          data: {},
          error:
            'Graph read-inbox failed: Graph 401:{"error":{"code":"InvalidAuthenticationToken","message":"IDX14100: JWT is not well formed, there are no dots (.)"}}',
          duration: 1,
        };
      }
      return { success: true, data: { messages: [] }, duration: 1 };
    },
    describeOutputs: () => [],
  };
  return { command, calls: () => calls };
}

function spellWithGraphPrereq(): SpellDefinition {
  return {
    name: 'oap-style-test-spell',
    prerequisites: [
      {
        name: 'GRAPH_ACCESS_TOKEN',
        detect: { type: 'env', key: 'GRAPH_ACCESS_TOKEN' },
        promptOnMissing: true,
        description: 'Microsoft Graph access token',
      },
    ],
    steps: [{ id: 'read-inbox', type: 'graph-flaky', config: {} }],
  };
}

// Reusable env-restore guard so a failed assertion doesn't leak GRAPH_ACCESS_TOKEN
// into other tests.
//
// #1093: hoist the tmpdir + CredentialStore to beforeAll. CredentialStore.unlock
// runs PBKDF2 with 100k iterations synchronously; doing that 5x per test file in
// `beforeEach` adds ~0.5–2 s of CPU per file under fork contention, pushing
// individual tests past vitest's per-test ceiling. State is still scoped per
// test — each test clears the stored credential in `afterEach`.
//
// #1102: also warm the SpellCaster pipeline (platform-sandbox detection,
// validator, prereq-checker — see helpers/warm-runner.ts) here in beforeAll.
// Without this, the headline test ate the ~500 ms cold-start inline and tipped
// past the 5 s per-test ceiling ~1/3 of the time under full-suite fork load.
let savedToken: string | undefined;
let tmpDir: string;
let store: CredentialStore;

let originalDelete: CredentialStore['delete'];
let originalStore: CredentialStore['store'];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-auth-e2e-'));
  store = new CredentialStore({
    filePath: join(tmpDir, 'credentials.json'),
    passphrase: 'test-passphrase-1234',
  });
  originalDelete = store.delete.bind(store);
  originalStore = store.store.bind(store);
  await warmRunnerPipeline(store, makeMemory());
});

beforeEach(() => {
  savedToken = process.env.GRAPH_ACCESS_TOKEN;
  delete process.env.GRAPH_ACCESS_TOKEN;
});

afterEach(async () => {
  if (savedToken === undefined) delete process.env.GRAPH_ACCESS_TOKEN;
  else process.env.GRAPH_ACCESS_TOKEN = savedToken;
  // Restore any monkey-patched methods from the test body (the headline test
  // wraps `delete` to simulate the user pasting a fresh token at the prompt).
  store.delete = originalDelete;
  store.store = originalStore;
  // Per-test state: clear any credentials this test stored so the next test
  // starts from an empty store. delete() is a no-op when the key isn't present.
  try { await store.delete('GRAPH_ACCESS_TOKEN'); } catch { /* fine — may not exist */ }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Tests
// ============================================================================

describe('System E2E — auth-error recovery (#1042)', () => {
  it('headline: stale token → confirm → fresh token → retry succeeds (real CredentialStore)', async () => {
    // Pre-store a "stale" token in the encrypted store + env.
    await store.store('GRAPH_ACCESS_TOKEN', 'stale-opaque-token-from-yesterday');
    process.env.GRAPH_ACCESS_TOKEN = 'stale-opaque-token-from-yesterday';

    const flaky = makeFlakyGraphCommand(/* failuresBeforeSuccess */ 1);
    const registry = new StepCommandRegistry();
    registry.register(flaky.command);
    const caster = new SpellCaster(registry, store, makeMemory());

    // Simulate the user typing a fresh token at the resolver's prompt by
    // intercepting the credentials accessor between the runner's clear and
    // the prereq resolver's get. The accessor hands back a fresh value to
    // the resolver, which writes it to env+store.
    const realDelete = store.delete.bind(store);
    const realStore = store.store.bind(store);
    let userPastedFresh = false;
    (store as unknown as { delete: (n: string) => Promise<boolean> }).delete = async (
      name: string,
    ): Promise<boolean> => {
      const r = await realDelete(name);
      // Mimic the resolver's TTY prompt eliciting a new token from the user.
      await realStore(name, 'fresh-real-graph-token-eyJ...working');
      userPastedFresh = true;
      return r;
    };

    const result = await caster.run(spellWithGraphPrereq(), {}, {
      authErrorConfirm: async (info) => {
        expect(info.stepId).toBe('read-inbox');
        expect(info.credKeys).toEqual(['GRAPH_ACCESS_TOKEN']);
        expect(info.pattern).toBe('msal-idx141');
        return true;
      },
    });

    expect(userPastedFresh).toBe(true);
    expect(flaky.calls()).toBe(2);
    expect(result.success).toBe(true);
    expect(result.steps[0].status).toBe('succeeded');

    // Verify the encrypted file on disk reflects the new token, not the stale one.
    const stored = await store.get('GRAPH_ACCESS_TOKEN');
    expect(stored).toBe('fresh-real-graph-token-eyJ...working');
    expect(process.env.GRAPH_ACCESS_TOKEN).toBe('fresh-real-graph-token-eyJ...working');

    // The credentials.json file should exist and contain encrypted data
    // (not the plaintext token — sanity check that we used the real
    // CredentialStore not a mock that skipped encryption).
    const credsPath = join(tmpDir, 'credentials.json');
    expect(existsSync(credsPath)).toBe(true);
    const raw = readFileSync(credsPath, 'utf-8');
    expect(raw).not.toContain('fresh-real-graph-token');
    expect(raw).not.toContain('stale-opaque-token');
  });

  it('initial cast (no stored creds, non-TTY): MISSING_CREDENTIAL surfaces unchanged', async () => {
    // Empty store, no env — recovery code should never trigger because
    // the spell fails at preflight resolution, not at step execution.
    const flaky = makeFlakyGraphCommand(Number.POSITIVE_INFINITY);
    const registry = new StepCommandRegistry();
    registry.register(flaky.command);
    const caster = new SpellCaster(registry, store, makeMemory());

    const result = await caster.run(spellWithGraphPrereq(), {});
    expect(result.success).toBe(false);
    expect(flaky.calls()).toBe(0); // step never ran — preflight blocked
    expect(result.errors[0].code).toBe('MISSING_CREDENTIAL');
  });

  it('happy path (valid stored creds): step succeeds, recovery never fires', async () => {
    await store.store('GRAPH_ACCESS_TOKEN', 'valid-and-working-token');
    process.env.GRAPH_ACCESS_TOKEN = 'valid-and-working-token';

    const flaky = makeFlakyGraphCommand(/* failuresBeforeSuccess */ 0);
    const registry = new StepCommandRegistry();
    registry.register(flaky.command);
    const caster = new SpellCaster(registry, store, makeMemory());

    let confirmCalled = false;
    const result = await caster.run(spellWithGraphPrereq(), {}, {
      authErrorConfirm: async () => { confirmCalled = true; return true; },
    });

    expect(confirmCalled).toBe(false);
    expect(flaky.calls()).toBe(1);
    expect(result.success).toBe(true);
  });

  it('confirm declined: original failure carried forward, encrypted store untouched', async () => {
    await store.store('GRAPH_ACCESS_TOKEN', 'still-working-token');
    process.env.GRAPH_ACCESS_TOKEN = 'still-working-token';

    const flaky = makeFlakyGraphCommand(/* failuresBeforeSuccess */ 5);
    const registry = new StepCommandRegistry();
    registry.register(flaky.command);
    const caster = new SpellCaster(registry, store, makeMemory());

    const result = await caster.run(spellWithGraphPrereq(), {}, {
      authErrorConfirm: async () => false, // user declines
    });

    expect(flaky.calls()).toBe(1); // no retry
    expect(result.success).toBe(false);
    // Original failure preserved — error code is the standard step failure,
    // not CREDENTIAL_LIKELY_STALE (that code is reserved for non-TTY surface
    // and after-reprompt second-failure).
    expect(result.steps[0].errorCode).toBe('STEP_EXECUTION_FAILED');
    // Store value is unchanged.
    expect(await store.get('GRAPH_ACCESS_TOKEN')).toBe('still-working-token');
  });

  it('non-TTY without host hook: surface CREDENTIAL_LIKELY_STALE (scheduler-friendly)', async () => {
    await store.store('GRAPH_ACCESS_TOKEN', 'stale-opaque');
    process.env.GRAPH_ACCESS_TOKEN = 'stale-opaque';

    const flaky = makeFlakyGraphCommand(Number.POSITIVE_INFINITY);
    const registry = new StepCommandRegistry();
    registry.register(flaky.command);
    const caster = new SpellCaster(registry, store, makeMemory());

    // No authErrorConfirm hook, no TTY in test env → recovery surfaces a
    // dedicated error code without prompting or destroying the store.
    const result = await caster.run(spellWithGraphPrereq(), {});

    expect(result.success).toBe(false);
    expect(flaky.calls()).toBe(1); // first attempt only
    expect(result.steps[0].errorCode).toBe('CREDENTIAL_LIKELY_STALE');
    expect(result.steps[0].error).toMatch(/CREDENTIAL_LIKELY_STALE.*GRAPH_ACCESS_TOKEN/);
    // Store untouched — non-TTY recovery is informational, not destructive.
    expect(await store.get('GRAPH_ACCESS_TOKEN')).toBe('stale-opaque');
  });
});
