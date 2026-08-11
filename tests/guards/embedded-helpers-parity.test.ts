/**
 * Guard: `flo init`'s fallback helpers are the canonical files, not copies of
 * them (#1443).
 *
 * `src/cli/init/executor.ts` writes `.claude/helpers/*` from `generateXScript()`
 * when `findSourceHelpersDir()` returns null — the "npx with broken paths" case.
 * Each generator used to carry a hand-maintained duplicate of the helper it
 * emits, and five of the seven had drifted. `gate.cjs` was the worst: 56KB
 * against the shipped 114KB, missing #1348's credit fingerprints entirely, so a
 * project that received the fallback had `testsRun` / `simplifyRun` /
 * `verifyRun` as sticky booleans that never invalidated when the code changed —
 * a gate that fails OPEN, on the path taken when an install is already degraded.
 *
 * They are now embedded at build time from the canonical files
 * (scripts/generate-embedded-helpers.mjs). This guard holds both ends of that:
 *
 *   1. every generator emits its canonical file byte-for-byte, and
 *   2. the committed `embedded-helpers.ts` is not stale.
 *
 * (2) is the one that matters day to day. The embed is committed so a clean
 * checkout can build and test without a prebuild, which means a contributor who
 * edits `bin/gate.cjs` and does not rebuild would otherwise ship an embed of the
 * PREVIOUS gate — the same silent drift, one level up. If this goes red, run
 * `npm run generate:helpers` and commit the result; never hand-edit the embed.
 *
 * Cross-platform (Rule #1): every comparison normalises CRLF. `.gitattributes`
 * checks these files out as LF everywhere, but a contributor's git config is not
 * something a guard should trust.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  generateGateScript,
  generateGateHookScript,
  generatePromptHookScript,
  generateHookHandlerScript,
  generateAutoMemoryHook,
  generatePreCommitHook,
  generatePostCommitHook,
} from '../../src/cli/init/helpers-generator.js';

const REPO_ROOT = resolve(__dirname, '../..');

/** LF-normalised read — see the Rule #1 note in the header. */
function read(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * generator → canonical file. Deliberately spelled out rather than imported
 * from the codegen script: a guard that derives its expectations from the thing
 * under test can only ever agree with it.
 */
const CASES: ReadonlyArray<readonly [string, () => string, string]> = [
  ['gate.cjs', generateGateScript, join(REPO_ROOT, 'bin', 'gate.cjs')],
  ['gate-hook.mjs', generateGateHookScript, join(REPO_ROOT, 'bin', 'gate-hook.mjs')],
  ['prompt-hook.mjs', generatePromptHookScript, join(REPO_ROOT, 'bin', 'prompt-hook.mjs')],
  ['hook-handler.cjs', generateHookHandlerScript, join(REPO_ROOT, 'bin', 'hook-handler.cjs')],
  ['auto-memory-hook.mjs', generateAutoMemoryHook, join(REPO_ROOT, '.claude', 'helpers', 'auto-memory-hook.mjs')],
  ['pre-commit', generatePreCommitHook, join(REPO_ROOT, '.claude', 'helpers', 'pre-commit')],
  ['post-commit', generatePostCommitHook, join(REPO_ROOT, '.claude', 'helpers', 'post-commit')],
];

describe('#1443 embedded helper parity', () => {
  it.each(CASES.map(([name]) => name))(
    'the init fallback emits the canonical %s byte-for-byte',
    (name) => {
      const [, generate, canonical] = CASES.find(([n]) => n === name)!;
      expect(
        generate().replace(/\r\n/g, '\n'),
        `The init fallback would write a ${name} that differs from the canonical file. ` +
          'Run `npm run generate:helpers` and commit src/cli/init/embedded-helpers.ts.',
      ).toBe(read(canonical));
    },
  );

  it('the committed embed is current with the canonical files', async () => {
    // Re-render from the same inputs the build uses and compare to what is on
    // disk. Importing the renderer keeps this honest: a change to how the module
    // is emitted (ordering, escaping, header) is caught too, not just content.
    const { renderEmbeddedHelpers, OUTPUT_PATH } = await import(
      '../../scripts/generate-embedded-helpers.mjs'
    );

    expect(
      read(OUTPUT_PATH),
      'src/cli/init/embedded-helpers.ts is stale — a canonical helper changed without ' +
        'the embed being regenerated, so `flo init`\'s fallback would write the previous ' +
        'version. Run `npm run generate:helpers` and commit the result.',
    ).toBe((renderEmbeddedHelpers() as string).replace(/\r\n/g, '\n'));
  });

  it('every embed decodes to real script content', async () => {
    // The failure this protects against is not hypothetical bookkeeping: the
    // fallback runs when an install is already broken, and a helper whose body
    // is empty — or the literal string "undefined" — is a corrupt gate, not a
    // degraded one. Base64 that decodes to nothing would sail past a
    // string-length check on the ENCODED value, so assert on the decoded text.
    const { EMBEDDED_HELPERS_BASE64 } = await import('../../src/cli/init/embedded-helpers.js');
    const names = Object.keys(EMBEDDED_HELPERS_BASE64);
    expect(names.sort()).toEqual(CASES.map(([n]) => n).slice().sort());

    for (const [name, encoded] of Object.entries(EMBEDDED_HELPERS_BASE64)) {
      expect(typeof encoded, `${name} embedded as a non-string`).toBe('string');
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      expect(decoded.length, `${name} decoded empty`).toBeGreaterThan(0);
      expect(decoded, `${name} decoded without a shebang — not a runnable helper`)
        .toMatch(/^#!/);
    }
  });
});
