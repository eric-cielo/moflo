/**
 * Skill + guidance size drift guard.
 *
 * Enforces the universal 500-line cap from
 * `.claude/guidance/shipped/moflo-guidance-rules.md` § 5 against:
 *
 *   1. Every `.claude/skills/<name>/SKILL.md` entry file. The full SKILL.md
 *      loads into context on every invocation, so each extra line is a
 *      per-invocation token cost across all consumers.
 *   2. Every `.claude/guidance/**\/*.md` file (shipped + internal + the
 *      auto-generated top-level mirror). Guidance gets RAG-chunked and
 *      Claude deprioritises content deep in long files.
 *
 * Companion files inside a skill directory (e.g. `architecture.md`,
 * `permissions.md`, `templates/*.md`) are EXEMPT — they only load when the
 * SKILL.md entry directs Claude to them, so the per-invocation cost story
 * doesn't apply.
 *
 * If this test fails, split the file by concern. For guidance: sibling files,
 * each owning one topic. For SKILL.md: progressive disclosure into companion
 * .md files in the same skill directory, with the entry SKILL.md linking to
 * them. See `moflo-guidance-rules.md` § 5 for the patterns.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');
const GUIDANCE_DIR = join(REPO_ROOT, '.claude/guidance');
const MAX_LINES = 500;

function countLines(path: string): number {
  return readFileSync(path, 'utf-8').split(/\r?\n/).length;
}

function listSkillEntries(): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const name of dirs) {
    const skillDir = join(SKILLS_DIR, name);
    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!isDir) continue;
    const skillMd = join(skillDir, 'SKILL.md');
    try {
      if (statSync(skillMd).isFile()) entries.push(skillMd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return entries;
}

function* walkGuidance(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkGuidance(full);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) yield full;
  }
}

function relFromRepo(absPath: string): string {
  return absPath.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
}

describe('skill + guidance size drift guard', () => {
  it(`every SKILL.md entry stays under ${MAX_LINES} lines`, () => {
    const offenders = listSkillEntries()
      .map((p) => ({ path: relFromRepo(p), lines: countLines(p) }))
      .filter((entry) => entry.lines > MAX_LINES)
      .sort((a, b) => b.lines - a.lines);

    expect(
      offenders,
      [
        `SKILL.md entries exceeding the ${MAX_LINES}-line cap (see`,
        '`.claude/guidance/shipped/moflo-guidance-rules.md` § 5):',
        '',
        ...offenders.map((o) => `  - ${o.path} (${o.lines} lines)`),
        '',
        'Fix: extract long sections into companion .md files in the same',
        'skill directory (progressive disclosure). The entry SKILL.md should',
        'link to them. Companion files do not count against the cap because',
        'Claude only loads them on demand.',
      ].join('\n'),
    ).toEqual([]);
  });

  it(`every .claude/guidance/**/*.md file stays under ${MAX_LINES} lines`, () => {
    const offenders = [...walkGuidance(GUIDANCE_DIR)]
      .map((p) => ({ path: relFromRepo(p), lines: countLines(p) }))
      .filter((entry) => entry.lines > MAX_LINES)
      .sort((a, b) => b.lines - a.lines);

    expect(
      offenders,
      [
        `Guidance files exceeding the ${MAX_LINES}-line cap (see`,
        '`.claude/guidance/shipped/moflo-guidance-rules.md` § 5):',
        '',
        ...offenders.map((o) => `  - ${o.path} (${o.lines} lines)`),
        '',
        'Fix: split into sibling files, each owning one topic. Update See Also',
        'sections to link the new files together.',
      ].join('\n'),
    ).toEqual([]);
  });
});
