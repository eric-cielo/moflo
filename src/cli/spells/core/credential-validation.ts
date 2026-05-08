/**
 * Credential Validation
 *
 * Shape checks applied to values pulled from the encrypted credential store
 * before they are promoted to `process.env`. Two layers:
 *
 *   1. **Author-declared format** (preferred): the YAML prereq sets
 *      `format: jwt`, and the validator enforces JWT shape + expiry. Any
 *      non-JWT value (e.g. a value with no dots) is rejected outright,
 *      catching the failure mode where a stored value isn't even a JWT
 *      and the spell would otherwise fail mid-cast with a 401.
 *
 *   2. **Conservative heuristics** (fallback when no format is declared):
 *        - JWT-shaped values (3 base64url segments) get their `exp` claim
 *          parsed and rejected when expired.
 *        - Env keys ending in `_URL` must parse via the WHATWG `URL`
 *          constructor and have a non-empty host.
 *      Anything else passes through.
 *
 * Story #1007: catch expired JWTs that survived past their TTL.
 * Story #1009: extend to catch values that aren't even JWT-shaped when
 * the prereq has declared `format: jwt`.
 */

import type { PrerequisiteFormat } from '../types/spell-definition.types.js';

const VALID_JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

export type StoredCredentialValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

export function validateStoredCredential(
  envKey: string,
  value: string,
  format?: PrerequisiteFormat,
): StoredCredentialValidation {
  if (format === 'jwt') {
    return validateJwtFormat(value);
  }
  if (envKey.endsWith('_URL')) {
    return validateUrlValue(value);
  }
  if (looksLikeJwt(value)) {
    return validateJwtExpiry(value);
  }
  return { valid: true };
}

function validateJwtFormat(value: string): StoredCredentialValidation {
  if (!looksLikeJwt(value)) {
    return {
      valid: false,
      reason: 'stored value is not a JWT (expected three base64url segments separated by ".")',
    };
  }
  return validateJwtExpiry(value);
}

function validateUrlValue(value: string): StoredCredentialValidation {
  try {
    const parsed = new URL(value);
    if (!parsed.host) {
      return { valid: false, reason: 'stored value is not a valid URL (missing host)' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'stored value is not a valid URL' };
  }
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  return parts.every(p => p.length > 0 && VALID_JWT_SEGMENT.test(p));
}

function validateJwtExpiry(value: string): StoredCredentialValidation {
  const exp = readJwtExp(value);
  if (exp == null) return { valid: true };
  const expiryMs = exp * 1000;
  const now = Date.now();
  if (expiryMs >= now) return { valid: true };
  return { valid: false, reason: `JWT expired ${formatDuration(now - expiryMs)} ago` };
}

function readJwtExp(value: string): number | null {
  try {
    const payload = value.split('.')[1];
    const padLen = (4 - (payload.length % 4)) % 4;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed === 'object' && parsed !== null) {
      const exp = (parsed as { exp?: unknown }).exp;
      if (typeof exp === 'number' && Number.isFinite(exp)) return exp;
    }
    return null;
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
