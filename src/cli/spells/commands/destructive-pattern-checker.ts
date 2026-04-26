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

/** Result of validating destructive scope against fs:write scope. */
export interface DestructiveScopeViolation {
  readonly path: string;
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
 * Check a shell command against the denylist with scoped path allowances.
 *
 * When `allowedPaths` is provided, destructive commands targeting ONLY those
 * paths are permitted. Destructive commands targeting paths outside the scope
 * are still blocked.
 *
 * @returns A `DestructiveMatch` if a dangerous pattern is found outside scope, or `null` if safe.
 */
export function checkDestructivePatternsScoped(
  command: string,
  allowedPaths: readonly string[],
): DestructiveMatch | null {
  for (const entry of DENYLIST) {
    if (entry.regex.test(command)) {
      // Check if the command targets only allowed paths
      if (isCommandWithinScope(command, entry, allowedPaths)) {
        continue; // Destructive but within scope — allowed
      }
      return { pattern: entry.pattern, reason: entry.reason };
    }
  }
  return null;
}

/**
 * Validate that scoped destructive paths are a subset of the step's fs:write scope.
 * Gateway enforcement: destructive scope must not exceed write scope.
 *
 * @returns Array of violations (empty if valid).
 */
export function validateDestructiveScope(
  destructivePaths: readonly string[],
  writePaths: readonly string[],
): DestructiveScopeViolation[] {
  if (writePaths.length === 0) {
    // No write scope declared — all destructive paths are violations
    return destructivePaths.map(p => ({
      path: p,
      reason: `Destructive path "${p}" has no matching fs:write scope`,
    }));
  }

  const normalizedWritePaths = writePaths.map(normalizePath);
  const violations: DestructiveScopeViolation[] = [];
  for (const dp of destructivePaths) {
    const normalized = normalizePath(dp);
    const covered = normalizedWritePaths.some(nwp =>
      normalized === nwp || normalized.startsWith(nwp + '/'),
    );
    if (!covered) {
      violations.push({
        path: dp,
        reason: `Destructive path "${dp}" is outside fs:write scope [${writePaths.join(', ')}]`,
      });
    }
  }
  return violations;
}

/**
 * Format a denylist match into a user-facing error message.
 */
export function formatDestructiveError(match: DestructiveMatch, scoped?: boolean): string {
  const hint = scoped
    ? 'Adjust `allowDestructive` scope to include the target path.'
    : 'Override with `allowDestructive: ["./path/"]` (scoped) in step config.';
  return `Command blocked: ${match.pattern} — ${match.reason}. ${hint}`;
}

/**
 * Format a scope violation into a user-facing error message.
 */
export function formatScopeViolation(violations: readonly DestructiveScopeViolation[]): string {
  const details = violations.map(v => `  - ${v.path}: ${v.reason}`).join('\n');
  return `Destructive scope exceeds fs:write scope:\n${details}`;
}

// ── Internal helpers ─────────────────────────────────────────────────────

/** Filesystem-related denylist patterns that support scoped overrides. */
const SCOPABLE_PATTERNS = new Set([
  'Recursive delete of root/home/system directories',
  'chmod -R 777',
  'mkfs/format on device',
]);

/** Normalize a path for comparison: strip trailing slashes, forward-slash only. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Check whether a destructive command targets only paths within the allowed scope.
 *
 * For filesystem-related patterns (rm, chmod, mkfs), extract target paths and
 * verify they fall within the allowed scope. For non-filesystem patterns
 * (git, SQL, fork bomb, curl|sh), scoping doesn't apply — those are always blocked
 * unless the full boolean override is used.
 */
function isCommandWithinScope(
  command: string,
  entry: DenylistEntry,
  allowedPaths: readonly string[],
): boolean {
  if (!SCOPABLE_PATTERNS.has(entry.pattern)) {
    return false; // Non-filesystem patterns can't be scoped
  }

  // Extract target paths from the command
  const targets = extractCommandTargets(command);
  if (targets.length === 0) return false;

  // All targets must be within at least one allowed path
  return targets.every(target => {
    const normalizedTarget = normalizePath(target);
    return allowedPaths.some(ap => {
      const normalizedAp = normalizePath(ap);
      return normalizedTarget === normalizedAp
        || normalizedTarget.startsWith(normalizedAp + '/');
    });
  });
}

/** Extract filesystem target paths from a shell command string. */
const PATH_RE = /(?:\.\/[\w./-]+|\/[\w./-]+|~\/[\w./-]+|[A-Z]:\\[\w.\\ /-]+)/gi;
function extractCommandTargets(command: string): string[] {
  const matches = command.match(PATH_RE);
  return matches ? [...new Set(matches)] : [];
}
