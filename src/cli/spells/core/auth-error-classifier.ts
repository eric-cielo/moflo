/**
 * Auth-Error Classifier
 *
 * Pattern-matches step-failure text against known upstream auth-shaped
 * signals (HTTP 401, OAuth `invalid_grant`, MS Graph `IDX1410x`, etc.).
 * The runner uses the result to offer in-product credential clearing +
 * re-prompt + single-retry instead of looping forever on a stale token.
 *
 * Design: pure function, no I/O, no `/g` flag (statefulness was banned in
 * `feedback_publish_catches_straggler_bugs.md`). Adding upstream-specific
 * signals is a one-line addition to {@link AUTH_ERROR_PATTERNS}.
 *
 * Story #1042.
 */

export type AuthPatternConfidence = 'high' | 'low';

export interface AuthPattern {
  /** Stable identifier for telemetry / unit-test assertions. */
  readonly name: string;
  /** Anchored to a single line; no `/g` flag (lastIndex statefulness). */
  readonly pattern: RegExp;
  readonly confidence: AuthPatternConfidence;
  /** Human-readable explanation surfaced to the user on prompt. */
  readonly reason: string;
}

/**
 * Initial pattern table from issue #1042. Order matters — high-confidence
 * upstream-specific patterns come before generic literals so the most
 * actionable `reason` is reported when a message matches several rules.
 */
export const AUTH_ERROR_PATTERNS: readonly AuthPattern[] = [
  {
    name: 'msal-idx141',
    pattern: /\bIDX1410[0-9]\b/,
    confidence: 'high',
    reason: 'Microsoft Identity token rejection (IDX1410x)',
  },
  {
    name: 'invalid-auth-token',
    pattern: /InvalidAuthenticationToken/i,
    confidence: 'high',
    reason: 'Microsoft Graph InvalidAuthenticationToken',
  },
  {
    name: 'github-bad-creds',
    pattern: /\bBad\s+credentials\b/i,
    confidence: 'high',
    reason: 'GitHub Bad credentials',
  },
  {
    name: 'oauth-invalid-grant',
    pattern: /\binvalid_grant\b/i,
    confidence: 'high',
    reason: 'OAuth2 invalid_grant',
  },
  {
    name: 'oauth-expired-token',
    pattern: /\bexpired[_\s-]token\b/i,
    confidence: 'high',
    reason: 'OAuth2 expired_token',
  },
  {
    name: 'token-expired-camel',
    pattern: /\bTokenExpired\b/,
    confidence: 'high',
    reason: 'TokenExpired',
  },
  {
    name: 'http-401',
    pattern: /(?:^|[^0-9])401(?:[^0-9]|$)/,
    confidence: 'high',
    reason: 'HTTP 401 (unauthorized)',
  },
  {
    name: 'http-403',
    pattern: /(?:^|[^0-9])403(?:[^0-9]|$)/,
    confidence: 'low',
    reason: 'HTTP 403 (forbidden)',
  },
  {
    name: 'unauthorized-word',
    pattern: /\bUnauthorized\b/,
    confidence: 'low',
    reason: 'unauthorized literal',
  },
];

export interface AuthErrorMatch {
  readonly pattern: AuthPattern;
}

/**
 * Match `text` against the pattern table. Returns the first matching
 * pattern (highest-priority hit) or null.
 *
 * `text` is treated as the entire stderr/error blob from a failed step;
 * patterns are non-anchored on purpose so they catch multi-line outputs.
 */
export function classifyAuthError(text: string): AuthErrorMatch | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (pattern.pattern.test(text)) return { pattern };
  }
  return null;
}
