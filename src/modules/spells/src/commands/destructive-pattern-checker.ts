/**
 * Destructive Command Pattern Checker
 *
 * Blocks known-catastrophic shell command patterns before execution.
 * Called in bash-command.ts after interpolation and gateway check.
 *
 * @see https://github.com/eric-cielo/moflo/issues/408
 */

export interface DestructiveMatch {
  readonly pattern: string;
  readonly reason: string;
}

interface DenylistEntry {
  readonly regex: RegExp;
  readonly pattern: string;
  readonly reason: string;
}

/**
 * Denylist entries. Each regex is case-insensitive.
 *
 * IMPORTANT: Patterns are crafted to avoid false positives on legitimate
 * commands (e.g. `rm -rf ./build/` is fine, `rm -rf /` is not).
 */
const DENYLIST: readonly DenylistEntry[] = [
  // ── Recursive delete of root/home ────────────────────────────────
  // Match `rm` with recursive/force flags targeting dangerous paths.
  // Dangerous paths: / (root), ~ (home), /etc, /usr, /var, /bin, /sbin,
  // /lib, /boot, /root, /home (alone — not /home/user/project/dist),
  // C:\ (Windows root).
  // End-of-string OR followed by space/wildcard — NOT followed by more path.
  {
    regex: /\brm\s+(?:-\w*[rfRF]\w*\s+)*(?:\/(?:\s|$|\*)|~(?:\/?\s|\/?\*|$)|(?:\/(?:home|etc|usr|var|bin|sbin|lib|boot|root))(?:\s|$|\*|\/\*)|[A-Z]:\\(?:\s|$|\\?\*))/i,
    pattern: 'Recursive delete of root/home/system directories',
    reason: 'Filesystem wipe — would destroy system or user files',
  },

  // ── Force push to main/master ────────────────────────────────────
  {
    regex: /\bgit\s+push\s+(?:.*\s)?(?:--force\b|-f\b).*\b(?:main|master)\b|\bgit\s+push\s+(?:.*\s)?\b(?:main|master)\b(?:.*\s)?(?:--force\b|-f\b)/i,
    pattern: 'Force push to main/master',
    reason: 'Overwriting shared git history on protected branches',
  },

  // ── Hard reset ───────────────────────────────────────────────────
  {
    regex: /\bgit\s+reset\s+--hard\b/i,
    pattern: 'git reset --hard',
    reason: 'Discarding uncommitted work — irreversible data loss',
  },

  // ── DROP TABLE / DROP DATABASE ───────────────────────────────────
  {
    regex: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    pattern: 'DROP TABLE/DATABASE/SCHEMA',
    reason: 'Database destruction — irreversible data loss',
  },

  // ── chmod -R 777 ─────────────────────────────────────────────────
  {
    regex: /\bchmod\s+(?:-\w*R\w*\s+)?777\b/i,
    pattern: 'chmod -R 777',
    reason: 'Permission blowout — makes files world-readable/writable/executable',
  },

  // ── mkfs / format ────────────────────────────────────────────────
  {
    regex: /\b(?:mkfs(?:\.\w+)?|format)\s+(?:\/dev\/|[A-Z]:)/i,
    pattern: 'mkfs/format on device',
    reason: 'Disk formatting — destroys all data on the device',
  },

  // ── Fork bomb patterns ───────────────────────────────────────────
  {
    regex: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;|:\(\)\{\s*:\|:&\s*\};|bomb\(\)\s*\{.*bomb\s*\|.*bomb/,
    pattern: 'Fork bomb',
    reason: 'System hang — exponential process spawning exhausts resources',
  },

  // ── curl/wget pipe to shell ──────────────────────────────────────
  {
    regex: /\b(?:curl|wget)\s+[^|]*\|\s*(?:ba)?sh\b|\b(?:curl|wget)\s+[^|]*\|\s*sudo\b/i,
    pattern: 'curl/wget piped to shell',
    reason: 'Remote code execution — runs untrusted code from the internet',
  },
];

/**
 * Check a shell command string against the destructive pattern denylist.
 *
 * @returns A `DestructiveMatch` if a dangerous pattern is found, or `null` if safe.
 */
export function checkDestructivePatterns(command: string): DestructiveMatch | null {
  for (const entry of DENYLIST) {
    if (entry.regex.test(command)) {
      return { pattern: entry.pattern, reason: entry.reason };
    }
  }
  return null;
}

/**
 * Format a denylist match into a user-facing error message.
 */
export function formatDestructiveError(match: DestructiveMatch): string {
  return `Command blocked: ${match.pattern} — ${match.reason}. Override with \`allowDestructive: true\` in step config.`;
}
