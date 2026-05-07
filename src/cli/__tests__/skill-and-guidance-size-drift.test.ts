/**
 * Skill + guidance + agent size drift guard.
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
 *   3. Every `.claude/agents/**\/*.md` entry file. The full agent .md is
 *      loaded as the subagent's system prompt on every `Agent({subagent_type})`
 *      invocation — same per-spawn token cost story as SKILL.md (#932).
 *
 * Companion files inside a skill or agent directory (e.g. `architecture.md`,
 * `permissions.md`, `templates/*.md`, `<agent>-protocols.md`) are EXEMPT —
 * they only load when the entry .md directs Claude to them, so the
 * per-invocation cost story doesn't apply. An "entry" file is identified by
 * the presence of YAML frontmatter with a `name:` field; companion files
 * have no frontmatter.
 *
 * If this test fails, split the file by concern. For guidance: sibling files,
 * each owning one topic. For SKILL.md / agent .md: progressive disclosure
 * into companion .md files in the same directory, with the entry linking to
 * them. See `moflo-guidance-rules.md` § 5 for the patterns.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');
const GUIDANCE_DIR = join(REPO_ROOT, '.claude/guidance');
const AGENTS_DIR = join(REPO_ROOT, '.claude/agents');
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

function* walkAgents(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkAgents(full);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) yield full;
  }
}

// Identify agent ENTRY .md files — those with a `name:` line in YAML
// frontmatter. Companion files (no frontmatter) are exempt from the cap.
function isAgentEntry(absPath: string): boolean {
  const text = readFileSync(absPath, 'utf-8');
  const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /^name:\s*\S+/m.test(fm[1]);
}

describe('skill + guidance + agent size drift guard', () => {
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

  it(`every .claude/agents/**/*.md ENTRY file stays under ${MAX_LINES} lines`, () => {
    const offenders = [...walkAgents(AGENTS_DIR)]
      .filter(isAgentEntry)
      .map((p) => ({ path: relFromRepo(p), lines: countLines(p) }))
      .filter((entry) => entry.lines > MAX_LINES)
      .sort((a, b) => b.lines - a.lines);

    expect(
      offenders,
      [
        `Agent entry files exceeding the ${MAX_LINES}-line cap (see`,
        '`.claude/guidance/shipped/moflo-guidance-rules.md` § 5):',
        '',
        ...offenders.map((o) => `  - ${o.path} (${o.lines} lines)`),
        '',
        'Fix: extract long sections into companion .md files in the same agent',
        'directory (progressive disclosure). The entry .md should link to them.',
        'Companion files (no YAML frontmatter) are exempt from the cap.',
      ].join('\n'),
    ).toEqual([]);
  });
});
