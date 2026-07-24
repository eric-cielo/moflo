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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');
const GUIDANCE_DIR = join(REPO_ROOT, '.claude/guidance');
const AGENTS_DIR = join(REPO_ROOT, '.claude/agents');
const MAX_LINES = 500;
// Always-resident frontmatter `description` caps — see the description-cap
// tests below for why these differ between agents, skills, and aliases.
const MAX_DESC_CHARS_AGENT = 400;
const MAX_DESC_CHARS_SKILL = 700;
const MAX_DESC_CHARS_ALIAS = 120;

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

// Extract the YAML frontmatter `description` value, joining continuation
// lines. YAML block scalars (`description: |`) and plain multi-line values
// both fold to a single space-joined string; the value ends at the next
// top-level key or the end of the frontmatter. Returns '' when absent.
function frontmatterDescription(absPath: string): string {
  const text = readFileSync(absPath, 'utf-8');
  const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  const collected: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (!capturing) {
      const start = line.match(/^description:\s*(.*)$/);
      if (!start) continue;
      capturing = true;
      // Strip a block-scalar indicator (`|`, `>`, `|-`, …) — it's syntax, not text.
      const first = start[1].replace(/^[|>][-+]?\s*$/, '');
      if (first) collected.push(first);
      continue;
    }
    // A new top-level key ends the value; indented lines continue it.
    if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(' ').trim();
}

describe('frontmatterDescription parser', () => {
  // Rule #1: this parser is the ONLY thing standing between a 1,300-char
  // description and the always-resident listing. If it fails to extract a
  // description it returns '', every cap below silently passes, and the guard
  // becomes decorative. CRLF is the realistic way that happens — moflo ships
  // LF and `.gitattributes` pins `eol=lf`, but a Windows contributor's editor
  // or a relaxed checkout can still produce CRLF frontmatter. A parser anchored
  // on bare \n would score those files as 0 chars and wave anything through.
  const write = (name: string, body: string): string => {
    const dir = join(REPO_ROOT, '.testoutput', 'fm-parse');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it('extracts a single-line description', () => {
    const p = write('single.md', '---\nname: a\ndescription: Hello there.\ncolor: red\n---\nbody\n');
    expect(frontmatterDescription(p)).toBe('Hello there.');
  });

  it('extracts an equivalent description from CRLF frontmatter', () => {
    const lf = write('eol-lf.md', '---\nname: a\ndescription: Hello there.\ncolor: red\n---\nbody\n');
    const crlf = write('eol-crlf.md', '---\r\nname: a\r\ndescription: Hello there.\r\ncolor: red\r\n---\r\nbody\r\n');
    expect(frontmatterDescription(crlf)).toBe(frontmatterDescription(lf));
    expect(frontmatterDescription(crlf)).not.toBe('');
  });

  it('folds a multi-line description and stops at the next top-level key', () => {
    const p = write('multi.md', '---\nname: a\ndescription: First line\n  second line\nthird line\ncolor: red\n---\n');
    expect(frontmatterDescription(p)).toBe('First line second line third line');
  });

  it('folds a block scalar without leaking the indicator', () => {
    const p = write('block.md', '---\nname: a\ndescription: |\n  Line one.\n  Line two.\ncolor: red\n---\n');
    expect(frontmatterDescription(p)).toBe('Line one. Line two.');
  });

  it('returns empty string when there is no frontmatter or no description', () => {
    expect(frontmatterDescription(write('none.md', 'just a body\n'))).toBe('');
    expect(frontmatterDescription(write('nodesc.md', '---\nname: a\ncolor: red\n---\n'))).toBe('');
  });

  it('measures the real base-template-generator description as non-empty', () => {
    // End-to-end anchor: if the parser ever stops seeing the real file, the
    // caps go vacuous. #1307 finding 4 is exactly this file.
    const real = join(AGENTS_DIR, 'base-template-generator.md');
    expect(frontmatterDescription(real).length).toBeGreaterThan(0);
  });
});

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

  // ── Frontmatter `description` caps (#1307 finding 4) ────────────────────
  //
  // The body caps above bound what loads ON DISPATCH. The `description` is a
  // different cost class: it is ALWAYS-RESIDENT — Claude Code lists every
  // installed skill and agent (name + description) in the system prompt of
  // every session, whether or not it is ever invoked. A description is a
  // ROUTING HINT; worked examples, protocols, and procedure belong in the
  // body, which the caps above already govern.
  //
  // What this caught: `base-template-generator`'s description embedded two
  // full `<example>` dialogues with `<commentary>` blocks — 1,287 chars, 43%
  // of the entire agent listing, resident in every consumer session forever.
  //
  // Separate caps because the two surfaces have different jobs: an agent
  // description is a short "dispatch me for X", while a skill description
  // legitimately encodes trigger conditions ("Use when…") that drive routing.
  it('no skill or agent `description` embeds <example> blocks', () => {
    const offenders = [
      ...listSkillEntries(),
      ...[...walkAgents(AGENTS_DIR)].filter(isAgentEntry),
    ]
      .map((p) => ({ path: relFromRepo(p), description: frontmatterDescription(p) }))
      .filter((e) => /<example>|<commentary>/.test(e.description))
      .map((e) => e.path);

    expect(
      offenders,
      [
        'Frontmatter `description` containing <example>/<commentary> blocks:',
        '',
        ...offenders.map((p) => `  - ${p}`),
        '',
        'The description is always-resident routing context in every session.',
        'Move worked examples into the body, which only loads on invocation.',
      ].join('\n'),
    ).toEqual([]);
  });

  it(`every agent \`description\` stays under ${MAX_DESC_CHARS_AGENT} chars`, () => {
    const offenders = [...walkAgents(AGENTS_DIR)]
      .filter(isAgentEntry)
      .map((p) => ({ path: relFromRepo(p), chars: frontmatterDescription(p).length }))
      .filter((e) => e.chars > MAX_DESC_CHARS_AGENT)
      .sort((a, b) => b.chars - a.chars);

    expect(
      offenders,
      [
        `Agent descriptions exceeding the ${MAX_DESC_CHARS_AGENT}-char cap:`,
        '',
        ...offenders.map((o) => `  - ${o.path} (${o.chars} chars)`),
        '',
        'The description is always-resident in every consumer session. Keep it',
        'to a routing hint ("dispatch me for X") and move detail into the body.',
      ].join('\n'),
    ).toEqual([]);
  });

  it(`every SKILL.md \`description\` stays under ${MAX_DESC_CHARS_SKILL} chars`, () => {
    const offenders = listSkillEntries()
      .map((p) => ({ path: relFromRepo(p), chars: frontmatterDescription(p).length }))
      .filter((e) => e.chars > MAX_DESC_CHARS_SKILL)
      .sort((a, b) => b.chars - a.chars);

    expect(
      offenders,
      [
        `SKILL.md descriptions exceeding the ${MAX_DESC_CHARS_SKILL}-char cap:`,
        '',
        ...offenders.map((o) => `  - ${o.path} (${o.chars} chars)`),
        '',
        'The description is always-resident in every consumer session. Keep it',
        'to the trigger conditions that drive routing; move procedure into the',
        'body or a companion file.',
      ].join('\n'),
    ).toEqual([]);
  });

  // Alias skills (pointer skills that defer wholesale to a canonical skill)
  // must NOT restate the canonical's behavioral description: two descriptions
  // of the same behavior compete for the same intent, so "clean up this diff"
  // ties between `distill` and `flo-simplify`. The alias only needs to be
  // findable by name. See #1307 finding 2.
  it('alias skills keep a pointer-only description', () => {
    const offenders = listSkillEntries()
      .map((p) => ({ path: relFromRepo(p), description: frontmatterDescription(p) }))
      .filter((e) => /^Alias for \//.test(e.description))
      .filter((e) => e.description.length > MAX_DESC_CHARS_ALIAS)
      .sort((a, b) => b.description.length - a.description.length);

    expect(
      offenders,
      [
        `Alias skill descriptions exceeding the ${MAX_DESC_CHARS_ALIAS}-char cap:`,
        '',
        ...offenders.map((o) => `  - ${o.path} (${o.description.length} chars)`),
        '',
        'An alias description should point at the canonical skill and stop —',
        'e.g. "Alias for /ward — see that skill\'s description." Restating the',
        'canonical behavior creates routing ambiguity between the two entries.',
      ].join('\n'),
    ).toEqual([]);
  });
});
