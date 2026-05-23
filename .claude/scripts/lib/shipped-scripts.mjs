/**
 * Reader for the canonical shipped-scripts manifest (shipped-scripts.json) —
 * the single source of truth for the scripts + helpers moflo syncs into a
 * consumer's `.claude/`. Replaces the hand-duplicated arrays that previously
 * lived in the launcher, the post-install bootstrap, executor.ts, and
 * moflo-init.ts (issue #1191).
 *
 * `.mjs` consumers (the launcher + the bootstrap) call this with their resolved
 * `bin/lib` directory so they read the FRESHLY-INSTALLED package's list, not a
 * possibly-stale synced copy. The TS twin (`src/cli/init/shipped-scripts.ts`)
 * resolves the same JSON through `findMofloPackageRoot()`.
 *
 * Throws on a missing/unparseable manifest — that means a broken package
 * install (the JSON ships alongside every other bin/lib file). Callers that can
 * tolerate degraded operation wrap this in try/catch (the launcher and bootstrap
 * do); init/upgrade paths let it throw, since they can't proceed past a broken
 * install anyway.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} binLibDir absolute path to the package's `bin/lib` directory
 * @returns {{ scriptFiles: string[], binHelperFiles: string[], sourceHelperFiles: string[] }}
 */
export function loadShippedScripts(binLibDir) {
  const manifest = JSON.parse(readFileSync(join(binLibDir, 'shipped-scripts.json'), 'utf-8'));
  return {
    scriptFiles: manifest.scriptFiles ?? [],
    binHelperFiles: manifest.binHelperFiles ?? [],
    sourceHelperFiles: manifest.sourceHelperFiles ?? [],
  };
}
