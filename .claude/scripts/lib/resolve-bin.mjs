/**
 * Shared moflo bin-script path resolver.
 *
 * Resolves a moflo bin script in a consumer project, preferring the
 * npm-installed copy over the .claude/scripts/ mirror so the spawned process
 * matches the installed package version.
 *
 * Resolution order (intentional — see #866):
 *   1. <projectRoot>/node_modules/moflo/bin/<localScript>  — published, atomic
 *   2. <projectRoot>/node_modules/.bin/<binName>           — npm-managed alias (only if binName given)
 *   3. <projectRoot>/.claude/scripts/<localScript>         — derived sync, can lag a session
 *   4. <projectRoot>/bin/<localScript>                     — DEV ONLY, opt-in via includeDevFallback
 *
 * Why bin-first matters: the .claude/scripts/ mirror is updated by a sync
 * step that races the launcher's section-3 file copies during the very
 * upgrade session, so a still-stale mirror can spawn pre-upgrade argv into
 * a post-upgrade chain (#866). The npm package copy is updated atomically
 * by `npm install moflo`, so spawning from there guarantees the running
 * script matches the installed package.
 *
 * Cross-platform: paths are joined via `node:path.resolve`, which normalises
 * separators on Windows + POSIX. Callers compute `projectRoot` themselves
 * (typically via findProjectRoot()) so this helper has no implicit cwd.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * @param {string} projectRoot     Consumer's project root (caller-computed).
 * @param {string|null} binName    npm bin alias (e.g. 'flo-index'), or null/undefined when no alias exists.
 * @param {string} localScript     Script filename (e.g. 'index-guidance.mjs').
 * @param {{ includeDevFallback?: boolean }} [opts]
 *   includeDevFallback: also probe `<projectRoot>/bin/<localScript>` for source-tree dev.
 * @returns {string|null}          Resolved absolute path, or null when no candidate exists.
 */
export function resolveMofloBin(projectRoot, binName, localScript, opts = {}) {
  for (const candidate of mofloBinCandidates(projectRoot, binName, localScript, opts)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Pure-function variant — returns the candidate list in resolution order
 * without touching the filesystem. Used by the source-invariant test that
 * pins the bin-first ordering, and by callers that want to log what was
 * probed when nothing resolved.
 */
export function mofloBinCandidates(projectRoot, binName, localScript, opts = {}) {
  const candidates = [
    resolve(projectRoot, 'node_modules', 'moflo', 'bin', localScript),
  ];
  if (binName) {
    candidates.push(resolve(projectRoot, 'node_modules', '.bin', binName));
  }
  candidates.push(resolve(projectRoot, '.claude', 'scripts', localScript));
  if (opts.includeDevFallback) {
    candidates.push(resolve(projectRoot, 'bin', localScript));
  }
  return candidates;
}
