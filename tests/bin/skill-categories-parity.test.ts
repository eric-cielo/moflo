/**
 * Drift guard + unit tests for the launcher's skill-category selection (#1308).
 *
 * `bin/lib/skill-categories.mjs` mirrors `SKILLS_MAP` from
 * `src/cli/init/executor.ts` because the launcher is a plain `.mjs` and cannot
 * import that TS const across the dist/source depth boundary. Same arrangement
 * as `internal-skills.mjs` / `internal-skills-parity.test.ts`.
 *
 * The parity test matters more than usual here: #1308 exists precisely because
 * two representations of the skill categories drifted apart silently and
 * disabled the whole selection mechanism. A mirror is a second chance to make
 * that same mistake, so it is pinned.
 */

import { describe, it, expect } from 'vitest';
import {
  SKILL_CATEGORIES_MAP,
  SKILL_CATEGORY_NAMES,
  ALWAYS_INSTALLED_SKILLS,
  parseSkillCategories,
  computeExcludedSkills,
} from '../../bin/lib/skill-categories.mjs';
import { SKILLS_MAP, INTERNAL_SKILLS } from '../../src/cli/init/executor.js';
import { SKILL_CATEGORIES } from '../../src/cli/init/types.js';

describe('skill-categories parity with SKILLS_MAP (#1308)', () => {
  it('mirrors the canonical SKILLS_MAP exactly', () => {
    expect(SKILL_CATEGORIES_MAP).toEqual(SKILLS_MAP);
  });

  it('category names match SKILL_CATEGORIES, the single source of truth', () => {
    expect(SKILL_CATEGORY_NAMES.slice().sort()).toEqual([...SKILL_CATEGORIES].sort());
  });

  it('every SKILLS_MAP key is a declared SKILL_CATEGORIES entry (the #1308 bug)', () => {
    // The original defect: SKILLS_MAP had keys (`memory`, `spells`) that the
    // config type did not declare, so they could never be selected.
    for (const key of Object.keys(SKILLS_MAP)) {
      expect(SKILL_CATEGORIES).toContain(key);
    }
  });
});

describe('parseSkillCategories', () => {
  it('returns null when moflo.yaml has no skills block (unconfigured)', () => {
    expect(parseSkillCategories('auto_update:\n  enabled: true\n')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(parseSkillCategories('')).toBeNull();
    expect(parseSkillCategories(undefined as unknown as string)).toBeNull();
  });

  it('parses flow style: categories: [core, memory]', () => {
    const yaml = 'skills:\n  categories: [core, memory]\n';
    expect(parseSkillCategories(yaml)).toEqual(['core', 'memory']);
  });

  it('parses block style with leading dashes', () => {
    const yaml = 'skills:\n  categories:\n    - core\n    - spells\n';
    expect(parseSkillCategories(yaml)).toEqual(['core', 'spells']);
  });

  it('strips quotes in both styles', () => {
    expect(parseSkillCategories('skills:\n  categories: ["core", \'memory\']\n'))
      .toEqual(['core', 'memory']);
    expect(parseSkillCategories('skills:\n  categories:\n    - "core"\n'))
      .toEqual(['core']);
  });

  it('handles CRLF line endings (Rule #1)', () => {
    // A Windows consumer hand-editing moflo.yaml writes CRLF. A parser anchored
    // on bare \n would return null and silently ignore their selection.
    const lf = 'skills:\n  categories:\n    - core\n    - memory\n';
    expect(parseSkillCategories(lf.replace(/\n/g, '\r\n'))).toEqual(['core', 'memory']);
    expect(parseSkillCategories('skills:\r\n  categories: [core]\r\n')).toEqual(['core']);
  });

  it('parses an explicitly empty flow list as a real (empty) selection', () => {
    // Distinct from unconfigured: [] means "only the always-installed skills".
    expect(parseSkillCategories('skills:\n  categories: []\n')).toEqual([]);
  });

  it('is not confused by an unrelated top-level key named categories', () => {
    expect(parseSkillCategories('other:\n  categories: [nope]\n')).toBeNull();
  });

  it('tolerates intervening keys inside the skills block', () => {
    const yaml = 'skills:\n  profile: custom\n  categories: [core]\n';
    expect(parseSkillCategories(yaml)).toEqual(['core']);
  });
});

describe('computeExcludedSkills', () => {
  it('excludes only INTERNAL_SKILLS when unconfigured — pre-#1308 behaviour', () => {
    // Rule #2: this is the path every existing consumer takes. Any extra
    // exclusion here silently strips their skills on upgrade.
    const excluded = computeExcludedSkills(null, INTERNAL_SKILLS);
    expect([...excluded].sort()).toEqual([...INTERNAL_SKILLS].sort());
  });

  it('excludes unselected categories when a selection is present', () => {
    const excluded = computeExcludedSkills(['core'], INTERNAL_SKILLS);
    for (const skill of SKILLS_MAP.memory) expect(excluded).toContain(skill);
    for (const skill of SKILLS_MAP.spells) expect(excluded).toContain(skill);
    for (const skill of SKILLS_MAP.core) expect(excluded).not.toContain(skill);
  });

  it('never excludes the /flo + /fl ticket spell', () => {
    // Installed by moflo-init.ts outside SKILLS_MAP; it is the headline entry
    // point, so no selection may gate it away.
    const excluded = computeExcludedSkills([], INTERNAL_SKILLS);
    for (const skill of ALWAYS_INSTALLED_SKILLS) expect(excluded).not.toContain(skill);
  });

  it('an EXPLICIT empty list excludes every category — not the same as unconfigured', () => {
    // `categories: []` is a real "bare minimum" selection; omitting the block
    // is "no restriction". Conflating them would either strip every skill from
    // consumers who never opted in, or silently ignore an explicit request.
    const explicitlyEmpty = computeExcludedSkills([], INTERNAL_SKILLS);
    const unconfigured = computeExcludedSkills(null, INTERNAL_SKILLS);

    for (const skills of Object.values(SKILLS_MAP)) {
      for (const s of skills) expect(explicitlyEmpty).toContain(s);
    }
    expect([...unconfigured].sort()).toEqual([...INTERNAL_SKILLS].sort());
    expect(explicitlyEmpty.size).toBeGreaterThan(unconfigured.size);
  });

  it('selecting every category excludes nothing beyond INTERNAL_SKILLS', () => {
    const excluded = computeExcludedSkills([...SKILL_CATEGORY_NAMES], INTERNAL_SKILLS);
    expect([...excluded].sort()).toEqual([...INTERNAL_SKILLS].sort());
  });

  it('ignores an unknown category rather than stripping everything', () => {
    // A typo in moflo.yaml must not silently wipe the consumer's skills.
    const excluded = computeExcludedSkills(['core', 'typoed-category'], INTERNAL_SKILLS);
    for (const skill of SKILLS_MAP.core) expect(excluded).not.toContain(skill);
  });

  it('still excludes INTERNAL_SKILLS even when a selection is present', () => {
    const excluded = computeExcludedSkills(['core', 'memory', 'spells'], INTERNAL_SKILLS);
    for (const s of INTERNAL_SKILLS) expect(excluded).toContain(s);
  });
});
