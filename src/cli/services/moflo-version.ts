/**
 * Resolve moflo's own package version at runtime.
 *
 * Walks upward from this file looking for the `package.json` whose `name` is
 * `moflo`. The upward walk — rather than a fixed `../../..` — is what makes
 * one implementation correct from both layouts this code runs in:
 *
 * - source tree:  `src/cli/services/`      -> repo-root `package.json`
 * - installed:    `.../moflo/dist/src/cli/services/` -> `.../moflo/package.json`
 *
 * The depth differs between those two, so any hardcoded relative path is wrong
 * in one of them. Matching on `name === 'moflo'` also means a consumer's own
 * `package.json` encountered on the way up is skipped rather than reported as
 * moflo's version.
 *
 * Cross-platform (Rule #1): `dirname`/`join` build every path, and the
 * `dirname(dir) === dir` termination reaches the root identically on POSIX
 * (`/`) and Windows (`C:\`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reported when the walk finds no moflo `package.json` — never throws. */
export const UNKNOWN_VERSION = 'unknown';

let cached: string | null = null;

/**
 * moflo's version string, or {@link UNKNOWN_VERSION} if it cannot be resolved.
 *
 * Callers are diagnostic surfaces (MCP `initialize`, status reporting), so a
 * missing or unreadable `package.json` degrades to a placeholder rather than
 * failing the call.
 */
export function getMofloVersion(): string {
  if (cached !== null) return cached;

  let version = UNKNOWN_VERSION;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        if (pkg.name === 'moflo' && typeof pkg.version === 'string') {
          version = pkg.version;
          break;
        }
      } catch {
        // No package.json here, or unreadable — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable in an exotic host — keep the placeholder.
  }

  cached = version;
  return version;
}
