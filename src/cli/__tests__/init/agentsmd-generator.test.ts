/**
 * Tests for init/agentsmd-generator.ts — the AGENTS.md interop projection (#1270).
 *
 * Covers the pure generate/extract/drift/inject helpers and the writeAgentsMd
 * I/O orchestrator, including merge-safety (never clobber user content outside
 * the markers), CRLF normalisation, and the opt-out toggle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AGENTS_MARKER_START,
  AGENTS_MARKER_END,
  generateAgentsMd,
  extractAgentsBlock,
  computeAgentsMdDrift,
  applyAgentsMdInjection,
  writeAgentsMd,
} from '../../init/agentsmd-generator.js';

describe('agentsmd-generator', () => {
  describe('generateAgentsMd', () => {
    it('wraps content in the AGENTS marker pair with a trailing newline', () => {
      const out = generateAgentsMd();
      expect(out.startsWith(AGENTS_MARKER_START)).toBe(true);
      expect(out.trimEnd().endsWith(AGENTS_MARKER_END)).toBe(true);
      expect(out.endsWith('\n')).toBe(true);
    });

    it('is tool-agnostic — points to the CLI, not Claude-specific MCP tools', () => {
      const out = generateAgentsMd();
      expect(out).toContain('flo-search');
      expect(out).not.toContain('mcp__moflo');
    });

    it('points to the same shipped guidance CLAUDE.md references (drift guard)', () => {
      const out = generateAgentsMd();
      expect(out).toContain('.claude/guidance/moflo-core-guidance.md');
      expect(out).toContain('.claude/guidance/moflo-agent-rules.md');
    });

    it('accepts and ignores an options argument (call-shape parity with generateClaudeMd)', () => {
      expect(generateAgentsMd({})).toBe(generateAgentsMd());
    });
  });

  describe('extractAgentsBlock', () => {
    it('returns null for empty/absent input', () => {
      expect(extractAgentsBlock(null)).toBeNull();
      expect(extractAgentsBlock(undefined)).toBeNull();
      expect(extractAgentsBlock('')).toBeNull();
      expect(extractAgentsBlock('# just a heading\n')).toBeNull();
    });

    it('extracts the block including both markers', () => {
      const canonical = generateAgentsMd();
      const file = `# Agent Configuration\n\n${canonical}`;
      const found = extractAgentsBlock(file);
      expect(found).not.toBeNull();
      expect(found!.block.startsWith(AGENTS_MARKER_START)).toBe(true);
      expect(found!.block.endsWith(AGENTS_MARKER_END)).toBe(true);
    });

    it('normalises CRLF so a Windows-checked-out file still matches', () => {
      const crlf = generateAgentsMd().replace(/\n/g, '\r\n');
      const found = extractAgentsBlock(crlf);
      expect(found).not.toBeNull();
      expect(found!.block).toContain(AGENTS_MARKER_START);
    });
  });

  describe('computeAgentsMdDrift', () => {
    const canonical = generateAgentsMd();

    it('no-file for null/undefined', () => {
      expect(computeAgentsMdDrift(null, canonical)).toBe('no-file');
      expect(computeAgentsMdDrift(undefined, canonical)).toBe('no-file');
    });

    it('no-marker when the file has no moflo block', () => {
      expect(computeAgentsMdDrift('# my own AGENTS.md\n', canonical)).toBe('no-marker');
    });

    it('in-sync when the block matches the canonical', () => {
      expect(computeAgentsMdDrift(`# Agent Configuration\n\n${canonical}`, canonical)).toBe('in-sync');
    });

    it('in-sync across CRLF line endings', () => {
      expect(computeAgentsMdDrift(canonical.replace(/\n/g, '\r\n'), canonical)).toBe('in-sync');
    });

    it('drifted when the block differs from the canonical', () => {
      const stale = `${AGENTS_MARKER_START}\n## Old moflo block\n${AGENTS_MARKER_END}\n`;
      expect(computeAgentsMdDrift(stale, canonical)).toBe('drifted');
    });
  });

  describe('applyAgentsMdInjection', () => {
    const canonical = generateAgentsMd();

    it('creates a fresh file (with a title) when contents are absent', () => {
      const r = applyAgentsMdInjection(null, canonical);
      expect(r.changed).toBe(true);
      expect(r.contents).toContain('# Agent Configuration');
      expect(r.contents).toContain(AGENTS_MARKER_START);
    });

    it('appends the block to a user-authored file — never clobbers their content', () => {
      const user = '# My AGENTS.md\n\nSome team-specific notes.\n';
      const r = applyAgentsMdInjection(user, canonical);
      expect(r.changed).toBe(true);
      expect(r.contents!.startsWith(user)).toBe(true);
      expect(r.contents).toContain(AGENTS_MARKER_START);
      expect(r.contents).toContain('Some team-specific notes.');
    });

    it('replaces a drifted block in place, preserving surrounding user content', () => {
      const stale = `# Agent Configuration\n\n${AGENTS_MARKER_START}\n## Old\n${AGENTS_MARKER_END}\n\n## My extra section\nkeep me\n`;
      const r = applyAgentsMdInjection(stale, canonical);
      expect(r.changed).toBe(true);
      expect(r.contents).toContain('## My extra section');
      expect(r.contents).toContain('keep me');
      expect(r.contents).not.toContain('## Old');
      expect(computeAgentsMdDrift(r.contents, canonical)).toBe('in-sync');
    });

    it('preserves CRLF user content outside the markers when refreshing a drifted block (#1270, Rule #1)', () => {
      // Windows checkout: CRLF everywhere. Only the stale moflo block should be
      // rewritten — the user's surrounding lines must keep their CRLF bytes.
      const userPrefix = '# Agent Configuration\r\n\r\n## Team notes\r\nline-a\r\nline-b\r\n\r\n';
      const staleBlock = `${AGENTS_MARKER_START}\r\n## stale\r\n${AGENTS_MARKER_END}`;
      const userSuffix = '\r\n\r\n## Footer\r\nkeep-crlf\r\n';
      const r = applyAgentsMdInjection(userPrefix + staleBlock + userSuffix, canonical);
      expect(r.changed).toBe(true);
      // Bytes before and after the block are untouched (CRLF intact).
      expect(r.contents!.startsWith(userPrefix)).toBe(true);
      expect(r.contents!.endsWith(userSuffix)).toBe(true);
      expect(r.contents).toContain('line-a\r\nline-b');
      expect(r.contents).toContain('## Footer\r\nkeep-crlf');
      expect(r.contents).not.toContain('## stale');
      expect(computeAgentsMdDrift(r.contents, canonical)).toBe('in-sync');
    });

    it('is a no-op when already in sync', () => {
      const inSync = `# Agent Configuration\n\n${canonical}`;
      const r = applyAgentsMdInjection(inSync, canonical);
      expect(r.changed).toBe(false);
      expect(r.contents).toBe(inSync);
    });
  });

  describe('writeAgentsMd', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentsmd-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('creates AGENTS.md when enabled and absent', () => {
      const r = writeAgentsMd(root, true);
      expect(r.status).toBe('created');
      const p = join(root, 'AGENTS.md');
      expect(existsSync(p)).toBe(true);
      expect(computeAgentsMdDrift(readFileSync(p, 'utf-8'), generateAgentsMd())).toBe('in-sync');
    });

    it('skips (no file written) when disabled via the opt-out toggle', () => {
      const r = writeAgentsMd(root, false);
      expect(r.status).toBe('skipped');
      expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    });

    it('is idempotent — a second run reports unchanged and does not rewrite', () => {
      writeAgentsMd(root, true);
      const before = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
      const r2 = writeAgentsMd(root, true);
      expect(r2.status).toBe('unchanged');
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(before);
    });

    it('refreshes a drifted block and reports updated, keeping user content', () => {
      const p = join(root, 'AGENTS.md');
      writeFileSync(p, `# Agent Configuration\n\n${AGENTS_MARKER_START}\n## stale\n${AGENTS_MARKER_END}\n\n## user\nmine\n`, 'utf-8');
      const r = writeAgentsMd(root, true);
      expect(r.status).toBe('updated');
      const after = readFileSync(p, 'utf-8');
      expect(after).toContain('## user');
      expect(after).toContain('mine');
      expect(computeAgentsMdDrift(after, generateAgentsMd())).toBe('in-sync');
    });
  });
});
