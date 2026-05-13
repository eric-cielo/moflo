/**
 * Skills classification drift guard.
 *
 * Every directory under `.claude/skills/` MUST be classified as one of:
 *   1. Listed in `SKILLS_MAP` (will be installed by `flo init` into the
 *      consumer's `<root>/.claude/skills/`).
 *   2. Listed in `INTERNAL_SKILLS` (ships in the npm tarball but is NOT
 *      installed — moflo-internal dev tooling, or upstream cruft pending
 *      modernization/removal).
 *   3. One of the `SPECIAL_INSTALL` skills (`flo` / `fl`) handled by a
 *      dedicated step in `moflo-init.ts` rather than the SKILLS_MAP loop.
 *
 * Without this guard, a new skill landing in `.claude/skills/` would either
 * silently miss `flo init` (consumers never get it — the failure mode that
 * caused #938 follow-up — `eldar` and `guidance` shipped to noone for months)
 * or silently install upstream cruft into every consumer (the failure mode
 * that filtered out 13 leftover skills, all telling consumers to run
 * `npx claude-flow` / `npx agentic-flow` CLIs they don't have).
 *
 * If this test fails, the new directory was added without a classification
 * decision. Either:
 *   - Add to SKILLS_MAP (verified moflo-quality, consumer-runnable).
 *   - Add to INTERNAL_SKILLS (ship in tarball but don't install).
 *   - Delete the directory (and its tarball entry will go with it).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './_helpers/repo-walk.js';
import { SKILLS_MAP, INTERNAL_SKILLS } from '../init/executor.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');

// `flo` (and its `fl` alias) install through `moflo-init.ts` step 3
// (`generateSkill`), not through SKILLS_MAP — they need the alias-rename trick.
// The drift guard recognises them as classified-but-special.
const SPECIAL_INSTALL = new Set(['flo', 'fl']);

function listSkillDirs(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((name) => {
      try {
        return statSync(join(SKILLS_DIR, name)).isDirectory();
      } catch (err) {
        // Tolerate the readdir/stat race (entry removed between calls — e.g.
        // a parallel test cleanup). Surface anything else so an unexpected
        // FS error doesn't silently mask a real classification miss.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    })
    .sort();
}

describe('skills classification drift guard', () => {
  it('every dir under .claude/skills/ is classified in SKILLS_MAP, INTERNAL_SKILLS, or SPECIAL_INSTALL', () => {
    const skillsMapEntries = new Set(Object.values(SKILLS_MAP).flat());
    const internalEntries = new Set(INTERNAL_SKILLS);
    const dirs = listSkillDirs();

    const unclassified: string[] = [];
    for (const dir of dirs) {
      if (skillsMapEntries.has(dir)) continue;
      if (internalEntries.has(dir)) continue;
      if (SPECIAL_INSTALL.has(dir)) continue;
      unclassified.push(dir);
    }

    expect(unclassified, [
      'Unclassified skills found in .claude/skills/. Each MUST be classified:',
      '  - Add to SKILLS_MAP in src/cli/init/executor.ts (verified moflo-quality, consumer-runnable)',
      '  - Add to INTERNAL_SKILLS in src/cli/init/executor.ts (ships in tarball but flo init does not copy)',
      '  - Delete the directory entirely',
      '',
      'Unclassified:',
      ...unclassified.map((d) => `  - ${d}`),
    ].join('\n')).toEqual([]);
  });

  it('SKILLS_MAP entries all exist on disk', () => {
    const dirs = new Set(listSkillDirs());
    const missing = Object.values(SKILLS_MAP)
      .flat()
      .filter((name) => !dirs.has(name));
    expect(missing, `SKILLS_MAP references skills that don't exist on disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('INTERNAL_SKILLS entries all exist on disk', () => {
    const dirs = new Set(listSkillDirs());
    const missing = INTERNAL_SKILLS.filter((name) => !dirs.has(name));
    expect(missing, `INTERNAL_SKILLS references skills that don't exist on disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('SKILLS_MAP and INTERNAL_SKILLS do not overlap', () => {
    const skillsMapEntries = new Set(Object.values(SKILLS_MAP).flat());
    const overlap = INTERNAL_SKILLS.filter((name) => skillsMapEntries.has(name));
    expect(overlap, `Skills in both SKILLS_MAP and INTERNAL_SKILLS (must be one or the other): ${overlap.join(', ')}`).toEqual([]);
  });

  it('SPECIAL_INSTALL skills exist on disk', () => {
    const dirs = new Set(listSkillDirs());
    for (const name of SPECIAL_INSTALL) {
      expect(dirs.has(name), `SPECIAL_INSTALL references missing skill dir: ${name}`).toBe(true);
    }
  });
});
