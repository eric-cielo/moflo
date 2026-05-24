/**
 * syncDirRecursive — recursive `.md` sync with top-level exclusion (#1186).
 *
 * The session-start launcher uses this to mirror `node_modules/moflo/.claude/
 * skills` (and `.claude/agents`) into consumer projects on each run. Skills
 * pass INTERNAL_SKILLS as `excludeTopLevel` so moflo-internal skills (`/publish`,
 * `/reset-epic`) ship in the tarball but never land in a consumer project —
 * while consumer-facing skills (e.g. /divine) still sync.
 *
 * Cross-platform: builds paths with path.join and exercises the same
 * forward-slash rel normalization the launcher relies on (rule #1).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { makeSyncer, syncDirRecursive } from '../../bin/lib/file-sync.mjs';
import { INTERNAL_SKILLS } from '../../bin/lib/internal-skills.mjs';

const roots: string[] = [];

function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-1186-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function writeAt(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeSkillsSrc(): string {
  const src = makeTempRoot('src');
  writeAt(src, 'divine/SKILL.md', '# divine\n');
  writeAt(src, 'commune/SKILL.md', '# commune\n');
  writeAt(src, 'publish/SKILL.md', '# publish (internal)\n');
  writeAt(src, 'reset-epic/SKILL.md', '# reset-epic (internal)\n');
  return src;
}

afterEach(() => {
  while (roots.length) {
    try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('syncDirRecursive (#1186)', () => {
  it('excludes INTERNAL_SKILLS top-level dirs while copying consumer-facing skills', async () => {
    const src = makeSkillsSrc();
    const dest = makeTempRoot('dest');
    const { syncFile } = makeSyncer({});

    await syncDirRecursive(src, '.claude/skills', {
      projectRoot: dest,
      syncFile,
      excludeTopLevel: new Set(INTERNAL_SKILLS),
    });

    // Consumer-facing skills land.
    expect(existsSync(join(dest, '.claude/skills/divine/SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, '.claude/skills/commune/SKILL.md'))).toBe(true);
    // moflo-internal skills are excluded.
    expect(existsSync(join(dest, '.claude/skills/publish/SKILL.md'))).toBe(false);
    expect(existsSync(join(dest, '.claude/skills/reset-epic/SKILL.md'))).toBe(false);
  });

  it('without an exclusion set, copies every skill (proves the exclusion is what gates it)', async () => {
    const src = makeSkillsSrc();
    const dest = makeTempRoot('dest-all');
    const { syncFile } = makeSyncer({});

    await syncDirRecursive(src, '.claude/skills', { projectRoot: dest, syncFile });

    expect(existsSync(join(dest, '.claude/skills/publish/SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, '.claude/skills/divine/SKILL.md'))).toBe(true);
  });

  it('copies only .md files and treats a missing source dir as a no-op', async () => {
    const src = makeTempRoot('src-mixed');
    writeAt(src, 'keep/SKILL.md', '# keep\n');
    writeAt(src, 'keep/notes.txt', 'not markdown\n');
    const dest = makeTempRoot('dest-mixed');
    const { syncFile } = makeSyncer({});

    await syncDirRecursive(src, '.claude/skills', { projectRoot: dest, syncFile });
    expect(existsSync(join(dest, '.claude/skills/keep/SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, '.claude/skills/keep/notes.txt'))).toBe(false);

    await expect(
      syncDirRecursive(join(src, '__missing__'), '.claude/skills', { projectRoot: dest, syncFile }),
    ).resolves.toBeUndefined();
  });
});
