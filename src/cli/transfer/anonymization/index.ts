/**
 * Anonymization Pipeline
 * PII detection and redaction before a CFP is shared **externally**.
 *
 * ── Secret-pattern sourcing (#1193) ─────────────────────────────────────────
 * The secret/credential *detection shapes* (Anthropic/OpenAI `sk-`/`sk-ant-`
 * keys, GitHub `ghp_`/`github_pat_`, AWS `AKIA…`, Slack `xox…`, Google `AIza…`,
 * JWTs, PEM private-key blocks, bearer / url / assigned secrets) are
 * SINGLE-SOURCED from the session-continuity scrubber `bin/lib/pii-scrub.mjs`
 * (its exported `SECRET_PATTERNS` + `scrubSecrets`).
 *
 * Before #1193 this module carried its own narrow `apiKey` regex
 * (`/\b(sk-|pk-|api[_-]?key[_-]?)[a-zA-Z0-9]{20,}\b/gi`). For `sk-ant-api03-…`
 * the hyphen after `sk-ant` broke the `[a-zA-Z0-9]{20,}` run, so a *live*
 * Anthropic key — plus GitHub/AWS/Slack tokens — survived anonymization and
 * could leak in a CFP published externally. Rather than re-type the broader
 * shapes here (which would drift from the scrubber), we load the canonical set.
 *
 * The two modules keep DIFFERENT threat models, so only the SECRET shapes are
 * shared, not the policies:
 *   - `pii-scrub.mjs` protects the user's OWN local disk → deliberately KEEPS
 *     benign context (file paths, IPs) and only nukes literal secrets.
 *   - this module pseudonymises for EXTERNAL publication → additionally strips
 *     emails / phones / IPs / home paths. Those non-secret PII patterns and
 *     their replacement policy stay defined locally below.
 *
 * ── Cross-boundary loading (CLAUDE.md Rule #1 + dogfooding) ──────────────────
 * `bin/lib/pii-scrub.mjs` lives outside this module's TypeScript compile unit.
 * A static `../../../../bin/lib/pii-scrub.mjs` import is the banned depth-mismatch
 * anti-pattern (the path differs between `src/cli/**` and `dist/src/cli/**`), so
 * the scrubber is reached the sanctioned way: `locateMofloRootPath()` (the
 * shared moflo-package anchor, which also existence-checks) + `pathToFileURL()`
 * + dynamic `import()`. `pathToFileURL` is what makes the ESM
 * `import()` work on Windows; the join is platform-agnostic. That dynamic load
 * is why `detectPII` / `redactPII` / `anonymizeCFP` / `scanCFPForPII` are async.
 *
 * The loader is fail-CLOSED: if the scrubber can't be resolved we throw rather
 * than silently export un-redacted content — a credential leak is the worse
 * outcome for an external-share path.
 */

import type {
  CFPFormat,
  AnonymizationLevel,
  PIIDetectionResult,
} from '../types.js';
import * as crypto from 'crypto';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { locateMofloRootPath } from '../../services/moflo-require.js';

/**
 * Non-secret PII detection patterns owned by THIS module's external-share
 * policy. Secret shapes are NOT here — they come from `bin/lib/pii-scrub.mjs`
 * (see file header) so they only have to be maintained in one place.
 */
const PII_PATTERNS: Record<string, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ipv4: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  ipv6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
  homePath: /\/(Users|home|Documents)\/[a-zA-Z0-9_.-]+/g,
  windowsPath: /[A-Z]:\\Users\\[a-zA-Z0-9_.-]+/g,
};

/**
 * Replacement policy for the local non-secret PII patterns above. Secret
 * replacements are applied by `scrubSecrets` from the shared module.
 */
const REDACTIONS: Record<string, string | ((match: string) => string)> = {
  email: (match) => `user_${hash(match).slice(0, 8)}@example.com`,
  phone: '[REDACTED_PHONE]',
  ipv4: '0.0.0.0',
  ipv6: '::1',
  homePath: '/user/anonymous',
  windowsPath: 'C:\\Users\\anonymous',
};

/** One secret-shape entry as exported by `bin/lib/pii-scrub.mjs`. */
interface SecretPattern {
  name: string;
  pattern: RegExp;
  replace: string | ((...args: any[]) => string);
}

interface PiiScrubModule {
  SECRET_PATTERNS: SecretPattern[];
  scrubSecrets: (text: string) => string;
}

/**
 * Lazily import the shared scrubber once per process and cache the promise.
 * Fail-closed: a missing/garbled scrubber throws so the export aborts instead
 * of shipping un-redacted credentials.
 */
let piiScrubPromise: Promise<PiiScrubModule> | null = null;

function loadPiiScrub(): Promise<PiiScrubModule> {
  if (!piiScrubPromise) {
    piiScrubPromise = (async () => {
      const scrubPath = locateMofloRootPath(join('bin', 'lib', 'pii-scrub.mjs'));
      if (!scrubPath) {
        throw new Error(
          '[anonymization] bin/lib/pii-scrub.mjs not found under the moflo package root — ' +
            'refusing to anonymize without the shared secret scrubber (would risk leaking ' +
            'credentials in an external share).'
        );
      }
      const mod = (await import(pathToFileURL(scrubPath).href)) as Partial<PiiScrubModule>;
      if (!Array.isArray(mod.SECRET_PATTERNS) || typeof mod.scrubSecrets !== 'function') {
        throw new Error(
          '[anonymization] bin/lib/pii-scrub.mjs is missing SECRET_PATTERNS/scrubSecrets — broken moflo install.'
        );
      }
      return mod as PiiScrubModule;
    })();
  }
  return piiScrubPromise;
}

/**
 * Hash a string for consistent pseudonymization
 */
function hash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Detect PII in a string. Combines the shared secret shapes (always `critical`)
 * with this module's local non-secret PII patterns.
 */
export async function detectPII(content: string): Promise<PIIDetectionResult> {
  const result: PIIDetectionResult = {
    found: false,
    count: 0,
    types: {},
    locations: [],
  };

  const record = (
    type: string,
    pattern: RegExp,
    severity: 'low' | 'medium' | 'high' | 'critical'
  ): void => {
    // Reset lastIndex defensively — these regexes are module-shared and carry
    // /g, so a prior .test()/.exec() elsewhere must not leak state.
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (!matches) return;
    result.found = true;
    result.count += matches.length;
    result.types[type] = (result.types[type] ?? 0) + matches.length;
    for (const match of matches.slice(0, 5)) {
      // Limit to first 5 samples
      result.locations.push({
        type,
        path: 'content',
        sample: match.slice(0, 20) + (match.length > 20 ? '...' : ''),
        severity,
      });
    }
  };

  const { SECRET_PATTERNS } = await loadPiiScrub();
  for (const { name, pattern } of SECRET_PATTERNS) {
    record(name, pattern, 'critical');
  }
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    record(type, pattern, getSeverity(type));
  }

  return result;
}

/**
 * Get severity for a local (non-secret) PII type. Secret shapes are always
 * reported as `critical` by `detectPII`, so they never reach this helper.
 */
function getSeverity(type: string): 'low' | 'medium' | 'high' | 'critical' {
  switch (type) {
    case 'email':
    case 'phone':
      return 'high';
    case 'ipv4':
    case 'ipv6':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Redact PII from a string. Secrets are removed first via the shared scrubber
 * (broad vendor-token coverage), then this module's external-share PII policy
 * pseudonymises emails / phones / IPs / home paths.
 */
export async function redactPII(content: string): Promise<string> {
  const { scrubSecrets } = await loadPiiScrub();
  let result = scrubSecrets(content);

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    pattern.lastIndex = 0;
    const replacement = REDACTIONS[type];
    result = result.replace(pattern, replacement as string);
  }

  return result;
}

/**
 * Apply anonymization to CFP document
 */
export async function anonymizeCFP(
  cfp: CFPFormat,
  level: AnonymizationLevel
): Promise<{ cfp: CFPFormat; transforms: string[] }> {
  const transforms: string[] = [];
  const anonymized = JSON.parse(JSON.stringify(cfp)) as CFPFormat;

  // Level: Minimal
  if (['minimal', 'standard', 'strict', 'paranoid'].includes(level)) {
    // Redact author display name
    if (anonymized.metadata.author?.displayName) {
      anonymized.metadata.author.displayName = undefined;
      transforms.push('author-name-removed');
    }
  }

  // Level: Standard
  if (['standard', 'strict', 'paranoid'].includes(level)) {
    // Redact PII from all string fields
    const jsonStr = JSON.stringify(anonymized.patterns);
    const redacted = await redactPII(jsonStr);
    anonymized.patterns = JSON.parse(redacted);
    transforms.push('pii-redacted');

    // Generalize timestamps
    anonymized.anonymization.timestampsGeneralized = true;
    transforms.push('timestamps-generalized');
  }

  // Level: Strict
  if (['strict', 'paranoid'].includes(level)) {
    // Hash all IDs
    for (const pattern of anonymized.patterns.routing) {
      pattern.id = `pattern_${hash(pattern.id).slice(0, 12)}`;
    }
    transforms.push('ids-hashed');

    // Remove context details
    for (const pattern of anonymized.patterns.routing) {
      pattern.context = undefined;
    }
    transforms.push('context-removed');

    anonymized.anonymization.pathsStripped = true;
    transforms.push('paths-stripped');
  }

  // Level: Paranoid
  if (level === 'paranoid') {
    // Add noise to numeric values (differential privacy)
    for (const pattern of anonymized.patterns.routing) {
      pattern.usageCount = Math.round(pattern.usageCount * (0.9 + Math.random() * 0.2));
      pattern.successRate = Math.min(1, Math.max(0, pattern.successRate + (Math.random() - 0.5) * 0.1));
    }
    transforms.push('differential-privacy-noise');

    // Remove all trajectory learnings
    for (const traj of anonymized.patterns.trajectory) {
      traj.learnings = [];
    }
    transforms.push('learnings-removed');
  }

  // Update anonymization record
  anonymized.anonymization.level = level;
  anonymized.anonymization.appliedTransforms = transforms;
  anonymized.anonymization.piiRedacted = level !== 'minimal';

  // Recalculate checksum
  const content = JSON.stringify({
    magic: anonymized.magic,
    version: anonymized.version,
    metadata: anonymized.metadata,
    patterns: anonymized.patterns,
  });
  anonymized.anonymization.checksum = hash(content);

  return { cfp: anonymized, transforms };
}

/**
 * Scan CFP for PII without modification
 */
export async function scanCFPForPII(cfp: CFPFormat): Promise<PIIDetectionResult> {
  const content = JSON.stringify(cfp.patterns);
  return detectPII(content);
}
