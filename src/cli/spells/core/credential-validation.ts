/**
 * Credential Validation
 *
 * Lightweight, no-config shape checks applied to values pulled from the
 * encrypted credential store before they are promoted to `process.env`.
 *
 * Two heuristics, both conservative — only invalidate when there is
 * positive evidence the stored value is bad. Anything we can't classify
 * passes through unchanged.
 *
 *   - JWT-shaped values (3 base64url segments) get their `exp` claim
 *     parsed and compared to "now". An expired JWT is reported as such.
 *   - Env keys ending in `_URL` must parse via the WHATWG `URL`
 *     constructor and have a non-empty host.
 *
 * Story #1007: avoid silently reusing stale stored credentials (e.g.
 * Microsoft Graph access tokens, which expire in ~1h) so the resolver
 * can fall through to the prompt path and the user understands why.
 */

const VALID_JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

export type StoredCredentialValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

export function validateStoredCredential(
  envKey: string,
  value: string,
): StoredCredentialValidation {
  if (envKey.endsWith('_URL')) {
    return validateUrlValue(value);
  }
  if (looksLikeJwt(value)) {
    return validateJwtExpiry(value);
  }
  return { valid: true };
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
