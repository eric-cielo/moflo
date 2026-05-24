/**
 * Divine Skill — Content Validation Tests (#1186)
 *
 * `/divine` is a skill-only feature: a structured-prompt loop over the
 * WebSearch/WebFetch tools + `memory_*`, no new runtime. There is no executable
 * logic to unit-test, so the meaningful guards are (a) the SKILL.md is
 * well-formed and (b) it documents the loop contract the issue specified.
 *
 * Contract from #1186:
 *   - Multi-hop loop with explicit confidence gating (continue < 0.6, target 0.8).
 *   - Honors a max-hop cap (default 5) and degrades gracefully offline.
 *   - Returns a cited synthesis (claims -> source URLs) with a confidence line.
 *   - Persists each research case to the `research` memory namespace, deduped,
 *     and retrieves prior cases for cross-session reuse.
 *   - No new dependencies (skill markdown only).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_PATH = path.resolve(__dirname, '../../.claude/skills/divine/SKILL.md');

describe('divine skill', () => {
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
    // This skill uses unquoted name/description (the commune/meditate style).
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
    it('name is "divine" and matches the directory', () => {
      expect(fmName).toBe('divine');
      expect(fmName.length).toBeLessThanOrEqual(64);
    });

    it('description is present, under 1024 chars, and mentions the core nouns', () => {
      expect(fmDescription.length).toBeGreaterThan(0);
      expect(fmDescription.length).toBeLessThanOrEqual(1024);
      const desc = fmDescription.toLowerCase();
      expect(desc).toContain('research');
      expect(desc).toContain('multi-hop');
      expect(desc).toContain('confidence');
    });

    it('description includes a "use when" trigger clause', () => {
      expect(fmDescription.toLowerCase()).toMatch(/use at|use when|use after/);
    });

    it('arguments field compiles as a valid regex (guards the SKILL.md arguments trap)', () => {
      // Claude Code regex-compiles the `arguments:` field; a bracketed
      // descending-letter range (e.g. `[--max-hops]` -> `x-h`) throws.
      expect(fmArguments.length).toBeGreaterThan(0);
      expect(() => new RegExp(fmArguments)).not.toThrow();
    });
  });

  describe('documents the #1186 contract', () => {
    it('describes the confidence gate with the 0.6 continue / 0.8 target thresholds', () => {
      expect(content).toContain('0.6');
      expect(content).toContain('0.8');
      expect(content.toLowerCase()).toContain('confidence');
    });

    it('uses the WebSearch and WebFetch tools for the hop loop', () => {
      expect(content).toContain('WebSearch');
      expect(content).toContain('WebFetch');
    });

    it('honors a max-hop cap with a default of 5', () => {
      const lower = content.toLowerCase();
      expect(lower).toMatch(/hop cap|max-hop|max hop/);
      expect(content).toMatch(/default\s*5|default\)?\s*\(?5/);
    });

    it('documents the four expansion moves', () => {
      const lower = content.toLowerCase();
      expect(lower).toContain('entity expansion');
      expect(lower).toContain('concept deepening');
      expect(lower).toContain('temporal progression');
      expect(lower).toContain('causal chain');
    });

    it('requires a cited synthesis tied to source URLs with a confidence line', () => {
      const lower = content.toLowerCase();
      expect(lower).toContain('cited');
      expect(lower).toContain('source url');
      expect(lower).toContain('confidence line');
    });

    it('retrieves and persists research cases via the research memory namespace', () => {
      expect(content).toContain('mcp__moflo__memory_search');
      expect(content).toContain('mcp__moflo__memory_store');
      expect(content).toMatch(/namespace:\s*"?research"?/);
      // Case-based learning: dedup before storing.
      expect(content.toLowerCase()).toContain('dedup');
      expect(content).toContain('0.80');
    });

    it('degrades gracefully offline instead of crashing', () => {
      const lower = content.toLowerCase();
      expect(lower).toContain('offline');
      expect(lower).toMatch(/not crash|never crash|do not crash/);
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

  // Registration ("divine" must be in SKILLS_MAP and exist on disk) is the
  // canonical job of tests/skills/skills-classification-drift.test.ts (mirrored at
  // src/cli/__tests__/) — not duplicated here. This file owns only the SKILL.md
  // content contract.
});
