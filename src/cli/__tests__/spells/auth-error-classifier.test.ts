/**
 * Tests for the auth-error pattern classifier (#1042).
 *
 * Each pattern in the table needs a positive case (the upstream-flavored
 * error string) and a negative case (something that looks similar but
 * shouldn't trigger). The classifier feeds the runner's recovery prompt
 * so false positives = spurious "clear credential?" prompt; false
 * negatives = silent failure loop. We accept some false positives at the
 * `low` confidence tier (HTTP 403, bare "Unauthorized") because the
 * runner only prompts when credentials exist in the spell's prereqs.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAuthError,
  AUTH_ERROR_PATTERNS,
} from '../../spells/core/auth-error-classifier.js';

describe('classifyAuthError', () => {
  describe('positive matches', () => {
    it('matches MS Identity IDX14100', () => {
      const m = classifyAuthError(
        'Graph 401: {"error":{"code":"InvalidAuthenticationToken","message":"IDX14100: JWT is not well formed"}}',
      );
      // First pattern in the table that matches wins; IDX1410 takes priority
      // over InvalidAuthenticationToken because the IDX code is the most
      // specific signal.
      expect(m).not.toBeNull();
      expect(m?.pattern.name).toBe('msal-idx141');
      expect(m?.pattern.confidence).toBe('high');
    });

    it('matches MS Identity IDX14101 / IDX14109 (range)', () => {
      expect(classifyAuthError('IDX14101: signing key not found')?.pattern.name).toBe('msal-idx141');
      expect(classifyAuthError('IDX14109: token expired')?.pattern.name).toBe('msal-idx141');
    });

    it('matches Microsoft Graph InvalidAuthenticationToken without IDX prefix', () => {
      const m = classifyAuthError('"code":"InvalidAuthenticationToken"');
      expect(m?.pattern.name).toBe('invalid-auth-token');
    });

    it('matches GitHub Bad credentials', () => {
      const m = classifyAuthError('{"message":"Bad credentials","status":"401"}');
      expect(m).not.toBeNull();
      // Highest priority pattern that matches — first hit wins. "401" gets
      // matched after "Bad credentials" in table order; the assertion just
      // confirms classification, not exact ordering.
      expect(['github-bad-creds', 'http-401']).toContain(m?.pattern.name);
    });

    it('matches OAuth2 invalid_grant', () => {
      const m = classifyAuthError('{"error":"invalid_grant","error_description":"refresh expired"}');
      expect(m?.pattern.name).toBe('oauth-invalid-grant');
    });

    it('matches OAuth2 expired_token (snake_case)', () => {
      expect(classifyAuthError('{"error":"expired_token"}')?.pattern.name).toBe('oauth-expired-token');
    });

    it('matches expired-token (hyphen) and "expired token" (space)', () => {
      expect(classifyAuthError('error: expired-token detected')?.pattern.name).toBe('oauth-expired-token');
      expect(classifyAuthError('the access token is expired token now')?.pattern.name).toBe('oauth-expired-token');
    });

    it('matches camelCase TokenExpired', () => {
      expect(classifyAuthError('TokenExpired: token has expired')?.pattern.name).toBe('token-expired-camel');
    });

    it('matches HTTP 401 in canonical "401:" form', () => {
      expect(classifyAuthError('Slack 401: invalid_auth')?.pattern.name).toBe('http-401');
    });

    it('matches HTTP 401 in "status: 401" form', () => {
      expect(classifyAuthError('status: 401, message: foo')?.pattern.name).toBe('http-401');
    });

    it('matches HTTP 403 (low confidence)', () => {
      const m = classifyAuthError('HTTP 403: forbidden');
      expect(m?.pattern.name).toBe('http-403');
      expect(m?.pattern.confidence).toBe('low');
    });

    it('matches bare "Unauthorized" (low confidence)', () => {
      const m = classifyAuthError('something Unauthorized something');
      expect(m?.pattern.name).toBe('unauthorized-word');
      expect(m?.pattern.confidence).toBe('low');
    });
  });

  describe('negative matches', () => {
    it('does not match generic network timeout', () => {
      expect(classifyAuthError('ETIMEDOUT: connect timeout after 5000ms')).toBeNull();
    });

    it('does not match HTTP 500 server errors', () => {
      expect(classifyAuthError('HTTP 500: internal server error')).toBeNull();
    });

    it('does not match HTTP 4040 (longer number containing 401-like substring)', () => {
      expect(classifyAuthError('error code: 4040 not found')).toBeNull();
    });

    it('does not match an 8401-like substring inside another number', () => {
      expect(classifyAuthError('processed 8401234 records')).toBeNull();
    });

    it('does not match "unauthorized" embedded mid-word', () => {
      // Word boundary check: "unauthorizedness" should not trigger.
      expect(classifyAuthError('flag: unauthorizedness=false')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(classifyAuthError('')).toBeNull();
    });

    it('returns null for non-string input (defensive)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(classifyAuthError(undefined as any)).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(classifyAuthError(null as any)).toBeNull();
    });
  });

  describe('table integrity', () => {
    it('has unique pattern names', () => {
      const names = AUTH_ERROR_PATTERNS.map(p => p.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('has no /g regex flags (lastIndex statefulness banned in feedback_publish_catches_straggler_bugs)', () => {
      for (const p of AUTH_ERROR_PATTERNS) {
        expect(p.pattern.flags).not.toContain('g');
      }
    });

    it('every pattern has a non-empty reason and a confidence tier', () => {
      for (const p of AUTH_ERROR_PATTERNS) {
        expect(p.reason.length).toBeGreaterThan(0);
        expect(['high', 'low']).toContain(p.confidence);
      }
    });
  });
});
