/**
 * Shipped `arguments:` fields must be regex-safe.
 *
 * Claude Code's slash-command harness compiles a SKILL.md's frontmatter
 * `arguments:` value as a JS regex. Any `[...]` segment whose contents put a
 * hyphen between two alphabetically-DESCENDING letters is read as a character
 * range and throws `SyntaxError: Range out of order in character class` — and
 * the skill then never loads at all. It is a total failure, not a degraded one,
 * and it is invisible until someone types the slash command.
 *
 * Every internal hyphen in a bracketed flag name is a candidate: `[--audit-only]`
 * compiles `t-o`, `[--no-judge]` compiles `o-j`, `[<topic-or-path>]` compiles
 * `r-p`. Ascending pairs (`[--unused-limit]` → `d-l`) happen to be legal, which
 * is exactly why this cannot be eyeballed — half of them work.
 *
 * The consumer smoke harness has checked this since two shipped skills broke on
 * it, but only against the INSTALLED package in CI. That left the source tree
 * unguarded: a new skill with a poisoned `arguments:` field passes the whole
 * local suite and fails a CI job minutes later. This test closes that window by
 * applying the identical rule to `.claude/skills/` directly.
 *
 * Keep the extraction in step with `verifyShippedSkillArguments` in
 * `harness/consumer-smoke/lib/checks.mjs`.
 *
 * **When this fails:** use `[options]` and document the flags in the body's
 * Modes table, the way `/flo` does. Do not escape the hyphens — the value is
 * read by humans, and a backslash there is worse than a generic placeholder.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/cli/__tests__/_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');

interface SkillArguments {
  skill: string;
  value: string;
}

function listSkillArguments(): SkillArguments[] {
  const out: SkillArguments[] = [];
  let names: string[];
  try {
    names = readdirSync(SKILLS_DIR);
  } catch {
    return out;
  }

  for (const name of names) {
    const skillMd = join(SKILLS_DIR, name, 'SKILL.md');
    try {
      if (!statSync(skillMd).isFile()) continue;
    } catch {
      continue; // not a skill dir, or removed mid-walk
    }

    const text = readFileSync(skillMd, 'utf-8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;

    const argLine = fm[1].split(/\r?\n/).find((l) => /^arguments:/.test(l));
    if (!argLine) continue;

    const value = argLine.replace(/^arguments:\s*/, '').replace(/^['"]|['"]$/g, '');
    if (value.length === 0) continue;
    out.push({ skill: name, value });
  }
  return out;
}

describe('shipped SKILL.md `arguments:` fields', () => {
  const declared = listSkillArguments();

  it('finds skills to check (guards against a broken walk silently passing)', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared)('$skill compiles every [...] segment as a regex', ({ value }) => {
    for (const segment of value.match(/\[[^\]]*\]/g) ?? []) {
      expect(
        () => new RegExp(segment),
        `\`${segment}\` is not a valid character class — the skill will not load. `
          + 'Use `[options]` and document the flags in the body.',
      ).not.toThrow();
    }
  });
});
