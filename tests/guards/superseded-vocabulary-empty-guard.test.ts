/**
 * Guard: `SUPERSEDED_VOCABULARY` must ship empty (#1466).
 *
 * The table maps retired terms to their replacements so `flo memory
 * audit-learnings` can flag learnings still speaking the old language. A rename
 * is always local to one project — the consumer that renamed `foo` to `bar` is
 * the only place an entry saying `foo` is stale — so a row committed here would
 * flag innocent entries in every other consumer's store the moment they
 * `npm install moflo`.
 *
 * It is also a Rule #3 surface. A rename is usually named after the thing being
 * renamed, so the row that documents it tends to carry a project's internal
 * vocabulary, and this file ships to every consumer and lives in git history
 * permanently.
 *
 * If this goes red: the fix is to take the row back out, not to allowlist it.
 * A project that wants entries flagged fills the table in downstream, where the
 * rename actually happened.
 */

import { describe, expect, it } from 'vitest';

import { SUPERSEDED_VOCABULARY } from '../../src/cli/memory/learnings-audit.js';

describe('SUPERSEDED_VOCABULARY ships empty (#1466)', () => {
  it('holds no rows', () => {
    expect(SUPERSEDED_VOCABULARY).toEqual([]);
  });

  it('is declared empty in source, not emptied at runtime', () => {
    // A runtime `.length = 0` or a filtered copy would satisfy the assertion
    // above while leaving the retired terms sitting in the shipped file — which
    // is the half of this that matters for disclosure.
    const source = fsReadSource();
    const declaration = /export const SUPERSEDED_VOCABULARY[^=]*=\s*(\[[^\]]*\])/.exec(source);

    expect(declaration, 'SUPERSEDED_VOCABULARY is no longer a literal array declaration').not.toBeNull();
    expect(declaration![1].replace(/\s/g, '')).toBe('[]');
  });
});

function fsReadSource(): string {
  // Imported lazily so the guard's failure message points at the assertion
  // rather than at a module-load error in a source-only checkout.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'memory', 'learnings-audit.ts'), 'utf-8');
}
