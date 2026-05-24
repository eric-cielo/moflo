/**
 * Credential / secret scrubber for the session-continuity persist path (#1185).
 *
 * THREAT MODEL — this scrubber has a deliberately narrow job: a session digest
 * is written to the user's OWN local `.moflo/moflo.db`, so the only thing we
 * must never persist is a literal *secret* that happened to appear in the
 * session (an API key, a JWT, a private-key block). We intentionally KEEP
 * benign context like file paths and branch names — they're the whole point of
 * a "where you left off" digest and are not sensitive on the user's own disk.
 *
 * Scope is intentionally minimal: persist useful context, never persist secrets.
 *
 * Pure + synchronous + dependency-free so a bin/*.mjs hook can call it on the
 * hot path without loading a model. Cross-platform (Rule #1): plain regex, no
 * shell, no path assumptions.
 */

/**
 * Ordered list of { name, pattern, replace } secret shapes. Order matters:
 * multi-line PEM blocks and specific vendor token formats are neutralised
 * before the generic `key=value` assignment sweep so the specific redaction
 * label wins.
 *
 * Each `pattern` carries the global flag so `String.replace` hits every match.
 */
export const SECRET_PATTERNS = [
  // PEM private-key blocks (RSA / EC / OPENSSH / generic) — match the whole block.
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  // JSON Web Tokens — header.payload.signature, both segments start with `eyJ`.
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: '[REDACTED_JWT]',
  },
  // OpenAI / Anthropic-style keys: sk-..., sk-ant-..., pk-...
  {
    name: 'openai-anthropic-key',
    pattern: /\b(?:sk|pk)-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: '[REDACTED_API_KEY]',
  },
  // AWS access key id.
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED_AWS_KEY]' },
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ + fine-grained github_pat_).
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replace: '[REDACTED_GITHUB_TOKEN]',
  },
  // Slack tokens.
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[REDACTED_SLACK_TOKEN]' },
  // Google API keys.
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: '[REDACTED_GOOGLE_KEY]' },
  // Bearer tokens in Authorization headers / curl snippets.
  {
    name: 'bearer-token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{16,}/g,
    replace: 'Bearer [REDACTED_TOKEN]',
  },
  // Credentials embedded in a URL: scheme://user:secret@host → drop the secret.
  // The negative lookahead keeps the scrub idempotent — it won't re-match the
  // `[REDACTED]` placeholder it just wrote (so containsSecret(scrubbed) is false).
  {
    name: 'url-credentials',
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+):(?!\[REDACTED\]@)[^/\s@]+@/g,
    replace: '$1:[REDACTED]@',
  },
  // Generic `secret=value` / `password: value` / `token = value` / `api_key=...`
  // assignments. Quote-aware so it stops at the closing quote or whitespace.
  // Runs LAST so the specific vendor formats above keep their precise labels.
  // The negative lookahead skips the `[REDACTED]` placeholder so a re-scan of
  // already-scrubbed text reports clean (idempotent detection).
  {
    name: 'assigned-secret',
    pattern: /\b(api[_-]?key|secret|password|passwd|token|access[_-]?token|auth[_-]?token)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"']{6,})/gi,
    replace: (_m, key, sep) => `${key}${sep}[REDACTED]`,
  },
];

/**
 * Replace every recognised secret in `text` with a redaction label. Returns the
 * scrubbed string. Non-string input is coerced to '' (capture must never throw).
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    // Fresh lastIndex each pass — these regexes are module-shared and carry /g,
    // so a prior `.test()`/`.exec()` elsewhere must not leak state (the exact
    // RegExp-lastIndex bug class from feedback_publish_catches_straggler_bugs).
    pattern.lastIndex = 0;
    out = out.replace(pattern, replace);
  }
  return out;
}

/**
 * True if `text` contains at least one recognised secret. Used by tests and by
 * the capture path's defensive "did we miss anything" assertion.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
