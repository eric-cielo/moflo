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
import { readdirSync, readFileSync } from 'node:fs';
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

/** Skill names inside executor.ts's SKILLS_MAP — i.e. the ones that DO ship. */
function parseExecutorSkillsMap(): string[] {
  const src = readFileSync(resolve(__dirname, '../../src/cli/init/executor.ts'), 'utf-8');
  // Anchor on the closing `\n};` at column 0 so a nested `}` inside the literal
  // cannot truncate the captured body early.
  const block = src.match(/SKILLS_MAP[^=]*=\s*\{([\s\S]*?)\n\};/);
  expect(block, 'SKILLS_MAP declaration not found in executor.ts').not.toBeNull();
  // Category keys are unquoted, so every quoted token in here is a skill name.
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
    // `/flfl` wraps `/fl` with the rules for developing MOFLO — cross-platform,
    // consumer blast radius, dogfooding. Correct in this repo, noise in a
    // consumer's, where none of the three describe their project.
    expect(BIN_INTERNAL_SKILLS).toContain('flfl');
  });

  it('classifies every skill directory, so a new one cannot default to shipping', () => {
    // The failure this guards is silent: `flo init` and the launcher both copy
    // what they are not told to skip, so an unclassified skill ships to every
    // consumer without anything failing.
    const skillDirs = readdirSync(resolve(__dirname, '../../.claude/skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    // Membership must be checked inside the SKILLS_MAP literal, not anywhere in
    // executor.ts: a whole-file grep passes as soon as the directory name shows
    // up in ANY quoted string or comment, so a genuinely unclassified skill
    // whose name collides with unrelated text would satisfy this vacuously —
    // and still leak through the launcher's blanket sync.
    const shipped = parseExecutorSkillsMap();
    const unclassified = skillDirs.filter(
      (name) =>
        !BIN_INTERNAL_SKILLS.includes(name) &&
        !shipped.includes(name) &&
        // `flo`/`fl` take a dedicated install path in moflo-init.ts rather than
        // appearing in either list.
        name !== 'flo' && name !== 'fl',
    );
    expect(unclassified, 'unclassified skills would ship to consumers by default').toEqual([]);
  });
});
