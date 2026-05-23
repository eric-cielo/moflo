/**
 * Parity guard: bin/lib/internal-skills.mjs must mirror INTERNAL_SKILLS in
 * src/cli/init/executor.ts.
 *
 * The session-start launcher is a plain .mjs and can't import the TS const
 * across the dist/source depth boundary, so the list is duplicated. This test
 * fails the moment the two drift — add/remove an internal skill in one place
 * but not the other and CI goes red. Without it, a new moflo-internal skill
 * could leak into every consumer (launcher copies it) or a consumer-facing
 * skill could be wrongly excluded.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INTERNAL_SKILLS as BIN_INTERNAL_SKILLS } from '../../bin/lib/internal-skills.mjs';

function parseExecutorInternalSkills(): string[] {
  const src = readFileSync(resolve(__dirname, '../../src/cli/init/executor.ts'), 'utf-8');
  // Anchor on the closing `];` (not a bare `]`) so a future multi-line entry
  // can't truncate the captured body at an early bracket.
  const block = src.match(/INTERNAL_SKILLS:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
  expect(block, 'INTERNAL_SKILLS declaration not found in executor.ts').not.toBeNull();
  // Strip line comments first — they contain apostrophes (e.g. "moflo's") that
  // would otherwise be picked up as bogus quoted entries.
  const body = block![1].replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
}

describe('internal-skills list parity (launcher vs executor)', () => {
  it('bin/lib/internal-skills.mjs matches executor.ts INTERNAL_SKILLS', () => {
    const tsList = parseExecutorInternalSkills();
    expect(tsList.length, 'parsed zero entries — the regex likely needs updating').toBeGreaterThan(0);
    expect(new Set(BIN_INTERNAL_SKILLS)).toEqual(new Set(tsList));
  });

  it('includes the known moflo-internal skills', () => {
    expect(BIN_INTERNAL_SKILLS).toContain('publish');
    expect(BIN_INTERNAL_SKILLS).toContain('reset-epic');
  });
});
