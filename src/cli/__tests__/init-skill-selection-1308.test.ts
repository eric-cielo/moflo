/**
 * Behaviour tests for skill-category selection (#1308).
 *
 * The pre-existing drift guard (`skills-classification-drift.test.ts`) asserts
 * only CLASSIFICATION completeness — that every shipped skill dir appears in
 * `SKILLS_MAP` or `INTERNAL_SKILLS`. That passed happily while the selection
 * mechanism was completely broken, because it never asserted that selecting a
 * category actually installs that category and nothing else.
 *
 * These tests assert the behaviour instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeInit, SKILLS_MAP, INTERNAL_SKILLS } from '../init/executor.js';
import {
  DEFAULT_INIT_OPTIONS,
  MINIMAL_INIT_OPTIONS,
  FULL_INIT_OPTIONS,
  SKILL_CATEGORIES,
  type InitOptions,
} from '../init/types.js';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

function makeTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-select-1308-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  return dir;
}

/** Install with ONLY the skills component, so nothing else muddies the result. */
async function installSkills(target: string, skills: InitOptions['skills']): Promise<string[]> {
  await executeInit({
    ...MINIMAL_INIT_OPTIONS,
    targetDir: target,
    sourceBaseDir: join(REPO_ROOT, '.claude'),
    components: {
      settings: false, skills: true, commands: false, agents: false, helpers: false,
      statusline: false, mcp: false, runtime: false, claudeMd: false, pathSetup: false,
    },
    skills,
  });
  const dir = join(target, '.claude', 'skills');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('skill-category selection installs what was selected (#1308)', () => {
  let target: string;
  beforeEach(() => { target = makeTarget(); });
  afterEach(() => { try { rmSync(target, { recursive: true, force: true }); } catch { /* ok */ } });

  it('core-only installs exactly the core set — no memory, no spells', async () => {
    const installed = await installSkills(target, {
      core: true, memory: false, spells: false, all: false,
    });

    for (const skill of SKILLS_MAP.core) expect(installed).toContain(skill);
    for (const skill of SKILLS_MAP.memory) expect(installed).not.toContain(skill);
    for (const skill of SKILLS_MAP.spells) expect(installed).not.toContain(skill);
  });

  it('memory category is reachable at all — it was not before #1308', async () => {
    // The regression under test: `memory` was a SKILLS_MAP key with no matching
    // config key, so this selection installed ZERO skills.
    const installed = await installSkills(target, {
      core: false, memory: true, spells: false, all: false,
    });

    expect(installed.length).toBeGreaterThan(0);
    for (const skill of SKILLS_MAP.memory) expect(installed).toContain(skill);
    for (const skill of SKILLS_MAP.core) expect(installed).not.toContain(skill);
  });

  it('spells category is reachable at all — it was not before #1308', async () => {
    const installed = await installSkills(target, {
      core: false, memory: false, spells: true, all: false,
    });

    expect(installed.length).toBeGreaterThan(0);
    for (const skill of SKILLS_MAP.spells) expect(installed).toContain(skill);
  });

  it('every declared category installs a non-empty set', async () => {
    // Guards the general shape of the bug rather than the two instances of it:
    // no category may be declared-but-unreachable.
    for (const category of SKILL_CATEGORIES) {
      const dir = makeTarget();
      try {
        const skills = { core: false, memory: false, spells: false, all: false };
        skills[category] = true;
        const installed = await installSkills(dir, skills);
        expect(installed.length, `category "${category}" installed nothing`).toBeGreaterThan(0);
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }
  });

  it('all:true installs every category and overrides the individual flags', async () => {
    const installed = await installSkills(target, {
      core: false, memory: false, spells: false, all: true,
    });

    for (const skills of Object.values(SKILLS_MAP)) {
      for (const skill of skills) expect(installed).toContain(skill);
    }
  });

  it('never installs INTERNAL_SKILLS, whatever is selected', async () => {
    const installed = await installSkills(target, {
      core: true, memory: true, spells: true, all: true,
    });
    for (const skill of INTERNAL_SKILLS) expect(installed).not.toContain(skill);
  });

  it('DEFAULT selects every category — consumers must not lose skills on upgrade', () => {
    // Rule #2. The launcher already syncs everything, so DEFAULT selecting a
    // subset would leave init and the launcher disagreeing (which is how the
    // bug hid). Assert the presets directly rather than via an install.
    for (const category of SKILL_CATEGORIES) {
      expect(DEFAULT_INIT_OPTIONS.skills[category], `DEFAULT must select "${category}"`).toBe(true);
      expect(FULL_INIT_OPTIONS.skills[category], `FULL must select "${category}"`).toBe(true);
    }
    // MINIMAL is deliberately core-only.
    expect(MINIMAL_INIT_OPTIONS.skills.core).toBe(true);
    expect(MINIMAL_INIT_OPTIONS.skills.memory).toBe(false);
    expect(MINIMAL_INIT_OPTIONS.skills.spells).toBe(false);
  });

  it('no preset declares a key that is not a real category', () => {
    // `github` / `browser` were exactly this: config keys selecting nothing.
    const allowed = new Set<string>([...SKILL_CATEGORIES, 'all']);
    for (const [name, preset] of Object.entries({
      DEFAULT: DEFAULT_INIT_OPTIONS, MINIMAL: MINIMAL_INIT_OPTIONS, FULL: FULL_INIT_OPTIONS,
    })) {
      for (const key of Object.keys(preset.skills)) {
        expect(allowed.has(key), `${name}_INIT_OPTIONS.skills has dead key "${key}"`).toBe(true);
      }
    }
  });
});
