/**
 * Tests for `validateStoredCredential` (#1007).
 *
 * Two heuristics, both conservative — only invalidate when the stored
 * value is positively bad. Anything else passes through unchanged.
 */

import { describe, it, expect } from 'vitest';
import { validateStoredCredential } from '../../spells/core/credential-validation.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.signature-placeholder`;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

describe('validateStoredCredential', () => {
  describe('JWT-shaped values', () => {
    it('passes when exp is in the future', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // +1h
      const token = makeJwt({ sub: 'user', exp: futureExp });
      expect(validateStoredCredential('GRAPH_ACCESS_TOKEN', token))
        .toEqual({ valid: true });
    });

    it('rejects when exp is in the past with a humanized duration', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 7200; // -2h
      const token = makeJwt({ sub: 'user', exp: pastExp });
      const result = validateStoredCredential('GRAPH_ACCESS_TOKEN', token);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/JWT expired/);
        expect(result.reason).toMatch(/h/); // duration includes hours
      }
    });

    it('passes when JWT has no exp claim (legacy/stateful tokens)', () => {
      const token = makeJwt({ sub: 'user' });
      expect(validateStoredCredential('GRAPH_ACCESS_TOKEN', token))
        .toEqual({ valid: true });
    });

    it('passes when JWT payload fails to decode (conservative)', () => {
      // Three valid-shape segments but middle is not valid base64-encoded JSON
      const token = 'aGVhZGVy.bm90LWpzb24.c2ln';
      expect(validateStoredCredential('TOKEN', token))
        .toEqual({ valid: true });
    });

    it('passes when exp is non-numeric (treats as no-exp)', () => {
      const token = makeJwt({ sub: 'user', exp: 'never' as unknown as number });
      expect(validateStoredCredential('TOKEN', token))
        .toEqual({ valid: true });
    });

    it('passes opaque API key (no JWT shape — not invalidated)', () => {
      expect(validateStoredCredential('GITHUB_TOKEN', 'ghp_abc123def456'))
        .toEqual({ valid: true });
    });

    it('passes a value with two dots that is not base64url (not JWT-shaped)', () => {
      expect(validateStoredCredential('TOKEN', 'foo.bar.baz!'))
        .toEqual({ valid: true });
    });

    it('passes a value with one dot (not 3 segments)', () => {
      expect(validateStoredCredential('TOKEN', 'header.payload'))
        .toEqual({ valid: true });
    });
  });

  describe('_URL keys', () => {
    it('passes a valid https webhook URL', () => {
      expect(validateStoredCredential(
        'SLACK_WEBHOOK_URL',
        'https://hooks.slack.com/services/T0/B0/abc',
      )).toEqual({ valid: true });
    });

    it('rejects raw garbage as URL', () => {
      const result = validateStoredCredential('SLACK_WEBHOOK_URL', 'not-a-url');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/not a valid URL/);
    });

    it('rejects an empty-host URL', () => {
      // A scheme-only URL has no host
      const result = validateStoredCredential('FOO_URL', 'file:///');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/missing host/);
    });

    it('passes a non-_URL key even if the value is garbage (not validated)', () => {
      expect(validateStoredCredential('OPAQUE_SECRET', 'not-a-url'))
        .toEqual({ valid: true });
    });
  });
});
