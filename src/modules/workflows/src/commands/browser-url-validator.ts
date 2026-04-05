/**
 * Browser URL Validator — SSRF protection for browser step commands.
 *
 * Fixes GitHub Issue #177: blocks dangerous URL schemes, private/internal IPs,
 * and localhost to prevent Server-Side Request Forgery.
 */

// ── Blocked schemes ──────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// ── Private / internal IP ranges ─────────────────────────────────────────────

/**
 * Parse a dotted-decimal IPv4 address into a 32-bit number.
 * Returns null if the string is not a valid IPv4 address.
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0; // ensure unsigned
}

/**
 * Check whether an IPv4 address (as a 32-bit number) falls within a CIDR range.
 */
function inCIDR(ip: number, base: number, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (base & mask);
}

interface CIDRRange {
  base: number;
  prefixLen: number;
}

const PRIVATE_IPV4_RANGES: CIDRRange[] = [
  { base: parseIPv4('127.0.0.0')!, prefixLen: 8 },     // loopback
  { base: parseIPv4('10.0.0.0')!, prefixLen: 8 },      // private class A
  { base: parseIPv4('172.16.0.0')!, prefixLen: 12 },   // private class B
  { base: parseIPv4('192.168.0.0')!, prefixLen: 16 },  // private class C
  { base: parseIPv4('169.254.0.0')!, prefixLen: 16 },  // link-local
  { base: parseIPv4('0.0.0.0')!, prefixLen: 8 },       // "this" network
];

/**
 * Check whether a hostname is a blocked IPv6 address.
 * We check for the bracket-wrapped forms that appear in URLs.
 */
function isBlockedIPv6(hostname: string): boolean {
  // Remove brackets if present (URL parser keeps them for IPv6)
  const raw = hostname.replace(/^\[|\]$/g, '');
  // Loopback
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') return true;
  // Unique local (fc00::/7 = fc00-fdff)
  if (/^f[cd]/i.test(raw)) return true;
  // Link-local (fe80::/10 = fe80-febf)
  if (/^fe[89ab]/i.test(raw)) return true;
  return false;
}

function isPrivateIP(hostname: string): boolean {
  // Try IPv4
  const ipv4 = parseIPv4(hostname);
  if (ipv4 !== null) {
    return PRIVATE_IPV4_RANGES.some(r => inCIDR(ipv4, r.base, r.prefixLen));
  }
  // Try IPv6
  return isBlockedIPv6(hostname);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a URL for safe browser navigation.
 * Throws if the URL uses a blocked scheme, targets localhost,
 * or resolves to a private/internal IP address.
 */
export function validateBrowserUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }

  // Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}" — only http: and https: are allowed`,
    );
  }

  // Hostname checks
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost') {
    throw new Error('Blocked URL: localhost is not allowed');
  }

  if (isPrivateIP(hostname)) {
    throw new Error(
      `Blocked URL: "${hostname}" resolves to a private/internal IP address`,
    );
  }
}
