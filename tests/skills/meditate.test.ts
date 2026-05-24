/**
 * Meditate Skill — Content Validation Tests (#1187)
 *
 * `/meditate` is a skill-only feature: a structured-prompt + `memory_store`
 * wrapper, no new runtime. There is no executable logic to unit-test, so the
 * meaningful guards are (a) the SKILL.md is well-formed and documents the
 * contract the issue specified, and (b) the skill is registered for shipping.
 *
 * Contract from #1187:
 *   - Produces a structured session retrospective.
 *   - Writes durable learnings to the `learnings` namespace, deduped.
 *   - Distinct store from passive session-continuity digests (.moflo/continuity/).
 *   - No new dependencies (skill markdown only).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_PATH = path.resolve(__dirname, '../../.claude/skills/meditate/SKILL.md');

describe('meditate skill', () => {
  let content: string;
  let frontmatter: string;
  let fmName: string;
  let fmDescription: string;
  let fmArguments: string;

  beforeAll(() => {
    content = fs.readFileSync(SKILL_PATH, 'utf-8');
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fm, 'SKILL.md must open with YAML frontmatter').not.toBeNull();
    frontmatter = fm![1];
    // This skill uses unquoted name/description (the commune/healer style).
    fmName = (frontmatter.match(/name:\s*(.+)/)?.[1] ?? '').trim();
    fmDescription = (frontmatter.match(/description:\s*(.+)/)?.[1] ?? '').trim();
    fmArguments = (frontmatter.match(/arguments:\s*"([^"]*)"/)?.[1] ?? '').trim();
  });

  describe('file structure', () => {
    it('exists and is non-empty', () => {
      expect(fs.existsSync(SKILL_PATH)).toBe(true);
      expect(content.length).toBeGreaterThan(100);
    });

    it('starts with YAML frontmatter delimiters', () => {
      expect(content.startsWith('---\r\n') || content.startsWith('---\n')).toBe(true);
    });
  });

  describe('YAML frontmatter', () => {
    it('name is "meditate" and matches the directory', () => {
      expect(fmName).toBe('meditate');
      expect(fmName.length).toBeLessThanOrEqual(64);
    });

    it('description is present, under 1024 chars, and mentions the core nouns', () => {
      expect(fmDescription.length).toBeGreaterThan(0);
      expect(fmDescription.length).toBeLessThanOrEqual(1024);
      const desc = fmDescription.toLowerCase();
      expect(desc).toContain('retrospective');
      expect(desc).toContain('learnings');
    });

    it('description includes a "use when" trigger clause', () => {
      expect(fmDescription.toLowerCase()).toMatch(/use at|use when|use after/);
    });

    it('arguments field compiles as a valid regex (guards the SKILL.md arguments trap)', () => {
      // Claude Code regex-compiles the `arguments:` field; a bracketed
      // descending-letter range (e.g. `[topic-or-path]` → `r-p`) throws.
      expect(fmArguments.length).toBeGreaterThan(0);
      expect(() => new RegExp(fmArguments)).not.toThrow();
    });
  });

  describe('documents the #1187 contract', () => {
    it('writes to the learnings memory namespace via memory_store', () => {
      expect(content).toContain('mcp__moflo__memory_store');
      expect(content).toMatch(/namespace:\s*"?learnings"?/);
    });

    it('dedups before storing (memory_search the learnings namespace)', () => {
      expect(content).toContain('mcp__moflo__memory_search');
      expect(content.toLowerCase()).toContain('dedup');
      // The dedup threshold convention used across moflo skills.
      expect(content).toContain('0.80');
    });

    it('declares a store distinct from passive session-continuity digests', () => {
      // The keepsake (learnings namespace) must never collide with the firehose
      // (.moflo/continuity/ JSON store).
      expect(content).toContain('.moflo/continuity/');
      expect(content.toLowerCase()).toMatch(/distinct|complementary|never the/);
    });

    it('describes a structured review of the session', () => {
      const lower = content.toLowerCase();
      expect(lower).toContain('what worked');
      expect(lower).toMatch(/failed|surprised/);
    });

    it('states it does not write code', () => {
      expect(content.toLowerCase()).toMatch(/no code|does not edit source|not a code-writing/);
    });
  });

  describe('consumer-clean (#940)', () => {
    it('does not leak moflo-internal issue refs', () => {
      // Consumers can't resolve #NNN against their own repo.
      expect(content).not.toMatch(/#\d{3,4}/);
      expect(content).not.toContain('github.com/eric-cielo/moflo/issues');
    });

    it('cross-references guidance via the consumer mirror path (no shipped/)', () => {
      expect(content).not.toContain('.claude/guidance/shipped/');
    });
  });

  // Registration ("meditate" must be in SKILLS_MAP and exist on disk) is the
  // canonical job of tests/skills/skills-classification-drift.test.ts — not
  // duplicated here. This file owns only the SKILL.md content contract.
});
