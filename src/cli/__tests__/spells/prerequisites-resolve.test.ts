/**
 * `resolveUnmetPrerequisites` tests — prompt + fail-fast paths (#460).
 *
 * Covers TTY prompting, non-TTY fail-fast, empty answers, command-type
 * prereqs that can't be resolved via prompt, explicit promptOnMissing=false,
 * and mid-prompt abort. See issue #522.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  compilePrerequisiteSpec,
  resolveUnmetPrerequisites,
  type PromptLineFn,
} from '../../spells/core/prerequisite-checker.js';
import type { Prerequisite } from '../../spells/types/step-command.types.js';
import type { PrerequisiteSpec } from '../../spells/types/spell-definition.types.js';
import { makePrereq } from './helpers/prereq-fixtures.js';
import { makeCredentials } from './helpers.js';

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeExpiredJwt(): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 7200 }));
  return `${header}.${payload}.signature-placeholder`;
}

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

  // ==========================================================================
  // Story #923 — credential store integration
  // ==========================================================================

  describe('credential store resolution chain (story #923)', () => {
    const KEY = 'CRED_STORE_TEST_923';
    beforeEach(() => { delete process.env[KEY]; });

    it('pulls value from store when env is unset — no prompt, no save', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials = makeCredentials({ [KEY]: 'value-from-store' });
      const promptLine = vi.fn<PromptLineFn>(async () => 'should-not-be-called');

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: () => {},
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(result.resolvedNames).toEqual(['TOKEN']);
      expect(process.env[KEY]).toBe('value-from-store');
      expect(promptLine).not.toHaveBeenCalled();
      expect(credentials.storeCalls).toEqual([]);
    });

    it('persists prompt answer to the store when user accepts the save offer (default Y)', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials = makeCredentials({});
      // First call: prereq value. Second call: save-offer answer (empty = default Y).
      const responses = ['fresh-answer', ''];
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: () => {},
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY]).toBe('fresh-answer');
      expect(credentials.storeCalls).toEqual([[KEY, 'fresh-answer']]);
      expect(promptLine).toHaveBeenCalledTimes(2);
    });

    it('does not persist when user declines the save offer (n)', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials = makeCredentials({});
      const responses = ['fresh-answer', 'n'];
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: () => {},
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY]).toBe('fresh-answer');
      expect(credentials.storeCalls).toEqual([]);
    });

    it('batches the save offer when multiple prereqs are prompted', async () => {
      const KEY_A = 'CRED_BATCH_A_1002';
      const KEY_B = 'CRED_BATCH_B_1002';
      delete process.env[KEY_A];
      delete process.env[KEY_B];

      const prereqA = compilePrerequisiteSpec({ name: 'A', detect: { type: 'env', key: KEY_A } });
      const prereqB = compilePrerequisiteSpec({ name: 'B', detect: { type: 'env', key: KEY_B } });
      const credentials = makeCredentials({});
      const responses = ['answer-a', 'answer-b', 'y'];
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');
      const logged: string[] = [];

      const result = await resolveUnmetPrerequisites([prereqA, prereqB], {
        interactive: true,
        promptLine,
        log: (l) => logged.push(l),
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(promptLine).toHaveBeenCalledTimes(3);
      expect(credentials.storeCalls).toEqual([
        [KEY_A, 'answer-a'],
        [KEY_B, 'answer-b'],
      ]);
      // The save-offer prompt mentions the count, not each name individually.
      const savePromptCall = promptLine.mock.calls[2][0];
      expect(savePromptCall).toMatch(/Save 2 credentials/);
    });

    it('does not show the save offer when no prereqs were prompted (all from store)', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials = makeCredentials({ [KEY]: 'cached' });
      const promptLine = vi.fn<PromptLineFn>(async () => 'should-not-fire');

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: () => {},
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(promptLine).not.toHaveBeenCalled();
      expect(credentials.storeCalls).toEqual([]);
    });

    it('forceCredentialReprompt skips store lookup and prompts even when value is cached', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials = makeCredentials({ [KEY]: 'old-stale-value' });
      const responses = ['rotated-value', 'y'];
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: () => {},
        credentials,
        forceCredentialReprompt: true,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY]).toBe('rotated-value');
      expect(credentials.storeCalls).toEqual([[KEY, 'rotated-value']]);
      // Two calls (value + save-offer) prove the store-lookup path was bypassed —
      // without forceCredentialReprompt, the cached value would have suppressed the prompt.
      expect(promptLine).toHaveBeenCalledTimes(2);
    });

    it('non-TTY + missing + no store → fails with MISSING_CREDENTIAL errorCode', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        docsUrl: 'https://docs.example/token',
        detect: { type: 'env', key: KEY },
      });

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: false,
      });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('MISSING_CREDENTIAL');
      expect(result.missingCredentials).toEqual([KEY]);
      expect(result.message).toContain('Missing credentials');
      expect(result.message).toContain(KEY);
      expect(result.message).toContain('https://docs.example/token');
      expect(result.message).toContain('flo spell credentials set');
    });

    it('non-TTY + store has the value → satisfies without errorCode', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials = makeCredentials({ [KEY]: 'unattended-value' });

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: false,
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(process.env[KEY]).toBe('unattended-value');
    });

    it('non-env unmet prereq (command) on non-TTY → falls through to standard error path, no MISSING_CREDENTIAL', async () => {
      const envPrereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        promptOnMissing: false, // explicit opt-out so it's not "promptable"
        detect: { type: 'env', key: KEY },
      });
      const cmdPrereq = compilePrerequisiteSpec({
        name: 'UNICORN_CLI',
        detect: { type: 'command', command: 'this-command-does-not-exist-xyz-923' },
      });

      const result = await resolveUnmetPrerequisites([envPrereq, cmdPrereq], {
        interactive: false,
      });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBeUndefined();
      expect(result.message).toContain('Missing prerequisites');
      expect(result.message).toContain('UNICORN_CLI');
    });

    // ==========================================================================
    // Story #1007 — auto-reject stale stored credentials (JWT-exp + URL shape)
    // ==========================================================================

    it('rejects an expired stored JWT and falls through to the prompt path', async () => {
      const KEY_EXP = 'CRED_EXPIRED_JWT_1007';
      delete process.env[KEY_EXP];

      const expiredJwt = makeExpiredJwt();
      const prereq = compilePrerequisiteSpec({
        name: 'GRAPH_ACCESS_TOKEN',
        detect: { type: 'env', key: KEY_EXP },
      });
      const credentials = makeCredentials({ [KEY_EXP]: expiredJwt });
      const responses = ['fresh-token', 'n']; // n = decline save offer
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');
      const logged: string[] = [];

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: (l) => logged.push(l),
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY_EXP]).toBe('fresh-token');
      // Banner explains why the stored value was rejected
      expect(logged.some(l => l.includes(`Stored ${KEY_EXP} rejected`))).toBe(true);
      expect(logged.some(l => l.includes('JWT expired'))).toBe(true);
    });

    it('rejects a malformed _URL stored value and falls through to the prompt path', async () => {
      const KEY_URL = 'CRED_BAD_1007_URL';
      delete process.env[KEY_URL];

      const prereq = compilePrerequisiteSpec({
        name: 'WEBHOOK',
        detect: { type: 'env', key: KEY_URL },
      });
      const credentials = makeCredentials({ [KEY_URL]: 'not-a-url' });
      const responses = ['https://hooks.example.com/x', 'n'];
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');
      const logged: string[] = [];

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: (l) => logged.push(l),
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY_URL]).toBe('https://hooks.example.com/x');
      expect(logged.some(l => l.includes(`Stored ${KEY_URL} rejected`))).toBe(true);
      expect(logged.some(l => l.includes('not a valid URL'))).toBe(true);
    });

    it('non-TTY + expired stored JWT → MISSING_CREDENTIAL with rejection reason in the message', async () => {
      const KEY_EXP_NI = 'CRED_EXPIRED_JWT_NI_1007';
      delete process.env[KEY_EXP_NI];

      const expiredJwt = makeExpiredJwt();
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY_EXP_NI },
      });
      const credentials = makeCredentials({ [KEY_EXP_NI]: expiredJwt });

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: false,
        credentials,
      });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('MISSING_CREDENTIAL');
      expect(result.message).toContain('Stored value(s) rejected');
      expect(result.message).toContain(KEY_EXP_NI);
      expect(result.message).toContain('JWT expired');
    });

    it('does NOT reject an opaque (non-JWT, non-URL) stored value — passes through unchanged', async () => {
      const KEY_OPAQUE = 'CRED_OPAQUE_1007';
      delete process.env[KEY_OPAQUE];

      const prereq = compilePrerequisiteSpec({
        name: 'API_KEY',
        detect: { type: 'env', key: KEY_OPAQUE },
      });
      const credentials = makeCredentials({ [KEY_OPAQUE]: 'sk_live_abc123' });
      const promptLine = vi.fn<PromptLineFn>(async () => 'should-not-be-called');

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: () => {},
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY_OPAQUE]).toBe('sk_live_abc123');
      expect(promptLine).not.toHaveBeenCalled();
    });

    it('credentials.store rejection is logged but does not abort the cast', async () => {
      const prereq = compilePrerequisiteSpec({
        name: 'TOKEN',
        detect: { type: 'env', key: KEY },
      });
      const credentials: import('../../spells/types/step-command.types.js').CredentialAccessor = {
        async get() { return undefined; },
        async has() { return false; },
        async store() { throw new Error('disk full'); },
      };
      // First call: prereq value. Second call: save-offer answer (default Y triggers the failing store).
      const responses = ['answer', ''];
      const promptLine = vi.fn<PromptLineFn>(async () => responses.shift() ?? '');
      const logged: string[] = [];

      const result = await resolveUnmetPrerequisites([prereq], {
        interactive: true,
        promptLine,
        log: (l) => logged.push(l),
        credentials,
      });

      expect(result.ok).toBe(true);
      expect(process.env[KEY]).toBe('answer');
      expect(logged.some(l => l.includes('disk full'))).toBe(true);
    });
  });
});
