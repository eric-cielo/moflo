/**
 * Shared harness for the ESLint source-guard suites.
 *
 * Both `hash-fallback-guard.test.ts` and `source-guards.test.ts` drive the
 * real ESLint API against the repo's own flat config — that is the whole
 * point: a guard is only proven by making ESLint actually fire it, not by
 * asserting on the config object. This module holds the parts they'd
 * otherwise duplicate verbatim.
 *
 * Note the ESLint instance is per-module-graph, so each test file still
 * constructs its own (vitest gives each file its own registry). Sharing the
 * code is the win here; sharing the instance across files is not something a
 * helper module can do.
 */

import { resolve } from 'node:path';

import { ESLint } from 'eslint';

export const REPO_ROOT = resolve(__dirname, '../../..');

let instance: ESLint | undefined;

/**
 * Lazily construct one ESLint instance per module graph. Construction parses
 * the full flat-config cascade (~300-700ms on Windows), so callers should not
 * build their own per test.
 */
export function guardLinter(): ESLint {
  instance ??= new ESLint({ cwd: REPO_ROOT });
  return instance;
}

/**
 * True when linting `source` as `filePath` produces at least one error from
 * `ruleId`.
 *
 * `filePath` drives config and override resolution; the file itself is never
 * written or read, so fixture paths may be fictitious — but paths that a
 * per-file exemption keys off must match that exemption exactly.
 *
 * A path the config ignores yields no results at all under ESLint 8 and an
 * ignore *warning* under 9+; both read as "no violation" here, which keeps
 * the suites version-agnostic across a toolchain bump.
 */
export async function violates(
  source: string,
  filePath: string,
  ruleId = 'no-restricted-syntax',
): Promise<boolean> {
  const results = await guardLinter().lintText(source, { filePath });
  return results.some(r =>
    r.messages.some(m => m.ruleId === ruleId && m.severity === 2),
  );
}
