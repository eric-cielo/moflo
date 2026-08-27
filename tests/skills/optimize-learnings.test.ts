/**
 * Optimize-Learnings Skill — Content Validation Tests (#1470)
 *
 * `/optimize-learnings` is a skill-only feature: a structured curation protocol
 * over `flo memory audit-learnings` + `memory_*`, with no new runtime. There is
 * no executable logic to unit-test, so the meaningful guards are (a) the
 * SKILL.md is well-formed and (b) it drives moflo's ACTUAL memory surfaces.
 *
 * (b) is the load-bearing half. The skill was ported from another project whose
 * tooling differed, and four of its premises are false in moflo. Each one, left
 * in, would instruct Claude to take a WRONG action against a consumer's store:
 *
 *   1. `cp` of a live WAL database as a backup — captures committed pages and
 *      silently drops whatever is still in the `-wal`. moflo has
 *      `flo memory backup` (VACUUM INTO, validated, atomic).
 *   2. `PRAGMA wal_checkpoint(TRUNCATE)` as the fix for (1) — can return `busy`
 *      and leave data in the `-wal` anyway. `snapshot-restore.ts` rejects it by
 *      name.
 *   3. A `reconcile-learnings-artifact` step to work around an additive
 *      `team-export` — moflo's export is a full reconcile that propagates
 *      rewrites and writes tombstones for deletions.
 *   4. A mandatory `rebuild-index` after deleting, to clear orphan vectors —
 *      the delete path already removes the row from the HNSW index.
 *
 * A fifth guard covers vocabulary: `learnings-audit.ts` emits KEEP / RETIRE /
 * COMPRESS / MERGE and states outright that two vocabularies for one decision
 * is how they drift apart. The reference skill's KEEP/REWRITE/MERGE/DELETE must
 * not reappear here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_DIR = path.resolve(__dirname, '../../.claude/skills/optimize-learnings');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');

describe('optimize-learnings skill', () => {
  let content: string;
  let frontmatter: string;
  let body: string;
  let fmName: string;
  let fmDescription: string;
  let fmArguments: string;

  beforeAll(() => {
    content = fs.readFileSync(SKILL_PATH, 'utf-8');
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fm, 'SKILL.md must open with YAML frontmatter').not.toBeNull();
    frontmatter = fm![1];
    body = content.slice(fm![0].length);
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

    it('carries the $ARGUMENTS passthrough block', () => {
      expect(body).toContain('$ARGUMENTS');
    });
  });

  describe('YAML frontmatter', () => {
    it('name is "optimize-learnings" and matches the directory', () => {
      expect(fmName).toBe('optimize-learnings');
      expect(path.basename(SKILL_DIR)).toBe(fmName);
    });

    it('description is present and within the always-resident cap', () => {
      expect(fmDescription.length).toBeGreaterThan(40);
      // Mirrors MAX_DESC_CHARS_SKILL in skill-and-guidance-size-drift.test.ts.
      expect(fmDescription.length).toBeLessThanOrEqual(700);
    });

    it('declares the audit-only mode in its arguments', () => {
      expect(fmArguments).toContain('--audit-only');
    });
  });

  describe('protocol sections', () => {
    it('documents every phase of the curation flow', () => {
      for (const heading of [
        'Memory first',
        'Snapshot before the first write',
        'Nominate mechanically',
        'durability bar',
        'verdict per entry',
        'Get approval, then apply',
        'Propagate, then re-probe',
      ]) {
        expect(body, `missing phase: ${heading}`).toContain(heading);
      }
    });

    it('opens with a Purpose line and closes with See Also', () => {
      expect(body).toContain('**Purpose:**');
      expect(body).toContain('## See Also');
    });

    it('requires memory-first before any other tool call', () => {
      expect(body).toContain('mcp__moflo__memory_search');
      expect(body).toMatch(/Memory-first is mandatory/i);
    });

    it('requires explicit approval before any write', () => {
      expect(body).toMatch(/approval before any write/i);
    });

    it('requires writing the canonical entry before deleting merged members', () => {
      expect(body).toMatch(/write before (you )?delete/i);
    });

    it('passes an explicit namespace on both memory mutations', () => {
      // Whitespace-tolerant: the two calls are column-aligned in the skill, and
      // a reflow must not fail a test whose subject is the explicit namespace.
      expect(body).toMatch(/mcp__moflo__memory_store\s+\{\s*namespace:\s*"learnings"/);
      expect(body).toMatch(/mcp__moflo__memory_delete\s+\{\s*namespace:\s*"learnings"/);
    });
  });

  describe("drives moflo's real memory surfaces", () => {
    it('backs up with `flo memory backup`, which is WAL-safe', () => {
      expect(body).toContain('flo memory backup --to');
      expect(body).toContain('VACUUM INTO');
    });

    it('nominates with `flo memory audit-learnings`', () => {
      expect(body).toContain('flo memory audit-learnings');
    });

    it('propagates with team-import before team-export', () => {
      expect(body).toContain('flo memory team-import');
      expect(body).toContain('flo memory team-export');
      expect(body.indexOf('flo memory team-import')).toBeLessThan(
        body.indexOf('flo memory team-export'),
      );
    });

    it('states that a retirement propagates as a tombstone', () => {
      expect(body).toContain('__moflo_tombstone__');
    });

    it('uses the audit\'s verdict vocabulary, not the reference skill\'s', () => {
      for (const verdict of ['KEEP', 'RETIRE', 'COMPRESS', 'MERGE']) {
        expect(body, `missing verdict: ${verdict}`).toContain(`**${verdict}**`);
      }
      expect(body).not.toContain('**REWRITE**');
      expect(body).not.toContain('**DELETE**');
    });

    it('says --apply archives RETIRE only, leaving COMPRESS and MERGE to an author', () => {
      expect(body).toMatch(/archives RETIRE and nothing else/i);
    });
  });

  describe('drops the reference skill\'s stale premises', () => {
    it('never instructs a file copy of the live database', () => {
      expect(body).not.toMatch(/\bcp\s+\.moflo[/\\]moflo\.db/);
    });

    it('never prescribes a WAL checkpoint as the backup fix', () => {
      // Named once, in Phase 2, only to say it is NOT the fix.
      const mentions = body.match(/wal_checkpoint/g) ?? [];
      expect(mentions.length).toBeLessThanOrEqual(1);
      if (mentions.length === 1) {
        expect(body).toMatch(/wal_checkpoint\(TRUNCATE\)` is not the fix/);
      }
    });

    it('never references the retired reconcile-artifact workaround', () => {
      expect(body).not.toContain('reconcile-learnings-artifact');
      expect(body).not.toContain('reconcile:learnings-artifact');
    });

    it('never claims team-export is additive on keys', () => {
      expect(body).not.toMatch(/additive on keys/i);
      expect(body).toMatch(/full reconcile, not an append/i);
    });

    it('never demands a rebuild-index to make a purge take effect', () => {
      expect(body).not.toContain('flo memory rebuild-index');
      expect(body).toMatch(/No reindex is needed/i);
    });

    it('never repeats the moflodb_batch delete warning, which no longer applies', () => {
      expect(body).not.toContain('moflodb_batch');
    });
  });

  describe('cross-platform (Rule #1)', () => {
    it('uses no POSIX-only shell builtins in its commands', () => {
      // `date +%F`, `$(...)`, and backtick substitution are all unavailable in
      // PowerShell, where a Windows consumer runs these verbatim.
      expect(body).not.toMatch(/\$\(date/);
      expect(body).not.toMatch(/date \+%/);
    });
  });
});
