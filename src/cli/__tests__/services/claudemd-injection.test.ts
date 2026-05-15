/**
 * CLAUDE.md injection drift detection tests (#1142).
 *
 * Validates the self-contained `claudemd-injection` module that the
 * session-start launcher and doctor check use to detect and repair drift
 * between a consumer's `<root>/CLAUDE.md` MoFlo-injected block and the
 * canonical block `claudemd-generator` produces.
 */
import { describe, it, expect } from 'vitest';
import {
  MARKER_START,
  MARKER_END,
  LEGACY_MARKER_STARTS,
  LEGACY_MARKER_ENDS,
  extractInjectedBlock,
  computeInjectionDrift,
  applyInjectionReplacement,
  formatInjectionDriftStatus,
} from '../../services/claudemd-injection.js';
import {
  generateClaudeMd,
  MARKER_START as GEN_MARKER_START,
  MARKER_END as GEN_MARKER_END,
} from '../../init/claudemd-generator.js';

// ──────────────────────────────────────────────────────────────────────────
// Cross-check: the inlined marker constants must match claudemd-generator
// ──────────────────────────────────────────────────────────────────────────

describe('claudemd-injection — marker parity with claudemd-generator', () => {
  it('MARKER_START matches the generator output', () => {
    expect(MARKER_START).toBe(GEN_MARKER_START);
  });
  it('MARKER_END matches the generator output', () => {
    expect(MARKER_END).toBe(GEN_MARKER_END);
  });
  it('legacy marker arrays are non-empty', () => {
    expect(LEGACY_MARKER_STARTS.length).toBeGreaterThan(0);
    expect(LEGACY_MARKER_ENDS.length).toBe(LEGACY_MARKER_STARTS.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// extractInjectedBlock
// ──────────────────────────────────────────────────────────────────────────

const CANONICAL = generateClaudeMd({});
const CANONICAL_BLOCK = CANONICAL.trimEnd();

describe('extractInjectedBlock', () => {
  it('returns null for null/empty input', () => {
    expect(extractInjectedBlock(null)).toBeNull();
    expect(extractInjectedBlock(undefined)).toBeNull();
    expect(extractInjectedBlock('')).toBeNull();
  });

  it('returns null when no marker pair is present', () => {
    expect(extractInjectedBlock('# Hello\n\nNo moflo block here.')).toBeNull();
  });

  it('finds the current marker pair and returns the full block', () => {
    const file = `# Project\n\n${CANONICAL_BLOCK}\n\nMore notes.`;
    const result = extractInjectedBlock(file);
    expect(result).not.toBeNull();
    expect(result!.markerIndex).toBe(0);
    expect(result!.block).toBe(CANONICAL_BLOCK);
  });

  it('finds legacy marker pairs and reports them with markerIndex >= 1', () => {
    const legacyBlock = `${LEGACY_MARKER_STARTS[0]}\nold content\n${LEGACY_MARKER_ENDS[0]}`;
    const file = `# Project\n\n${legacyBlock}\n`;
    const result = extractInjectedBlock(file);
    expect(result).not.toBeNull();
    expect(result!.markerIndex).toBe(1);
    expect(result!.block).toBe(legacyBlock);
  });

  it('normalises CRLF to LF before matching', () => {
    const crlf = `# Project\r\n\r\n${CANONICAL_BLOCK.replace(/\n/g, '\r\n')}\r\n`;
    const result = extractInjectedBlock(crlf);
    expect(result).not.toBeNull();
    expect(result!.markerIndex).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// computeInjectionDrift — five states
// ──────────────────────────────────────────────────────────────────────────

describe('computeInjectionDrift — five states', () => {
  it("state='no-file' when input is null", () => {
    const report = computeInjectionDrift(null, CANONICAL);
    expect(report.state).toBe('no-file');
  });

  it("state='no-marker' when file has no MoFlo block", () => {
    const report = computeInjectionDrift('# Project\nNo block.', CANONICAL);
    expect(report.state).toBe('no-marker');
  });

  it("state='legacy-marker' when file uses a legacy marker pair", () => {
    const legacy = `# Project\n\n${LEGACY_MARKER_STARTS[0]}\nold\n${LEGACY_MARKER_ENDS[0]}\n`;
    const report = computeInjectionDrift(legacy, CANONICAL);
    expect(report.state).toBe('legacy-marker');
    expect(report.legacyMarkerIndex).toBe(0);
  });

  it("state='in-sync' when block content matches canonical", () => {
    const file = `# Project\n\n${CANONICAL_BLOCK}\n`;
    const report = computeInjectionDrift(file, CANONICAL);
    expect(report.state).toBe('in-sync');
  });

  it("state='drifted' when current markers wrap stale content", () => {
    const stale = `${MARKER_START}\n## MoFlo (old)\n\nstale guidance pointer to .claude/guidance/shipped/moflo-core-guidance.md\n${MARKER_END}`;
    const file = `# Project\n\n${stale}\n`;
    const report = computeInjectionDrift(file, CANONICAL);
    expect(report.state).toBe('drifted');
  });

  it("treats motailz-style stale block as 'drifted'", () => {
    // Frozen fixture replicating the broken state captured from motailz/code.
    const motailzBlock = [
      MARKER_START,
      '## MoFlo — AI Agent Orchestration',
      '',
      'This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development spells.',
      '',
      '### Full Reference',
      '',
      'For CLI commands, hooks, agents, swarm config, memory commands, and moflo.yaml options, see:',
      '`.claude/guidance/shipped/moflo-core-guidance.md`',
      MARKER_END,
    ].join('\n');
    const file = `# Project\n\n${motailzBlock}\n`;
    const report = computeInjectionDrift(file, CANONICAL);
    expect(report.state).toBe('drifted');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyInjectionReplacement
// ──────────────────────────────────────────────────────────────────────────

describe('applyInjectionReplacement', () => {
  it('writes a fresh CLAUDE.md when input is null (no-file state)', () => {
    const result = applyInjectionReplacement(null, CANONICAL);
    expect(result.changed).toBe(true);
    expect(result.contents).not.toBeNull();
    expect(result.contents).toContain(CANONICAL_BLOCK);
    expect(result.state).toBe('in-sync');
  });

  it('appends the canonical block when no marker pair exists', () => {
    const before = '# Project\n\nSome notes.\n';
    const result = applyInjectionReplacement(before, CANONICAL);
    expect(result.changed).toBe(true);
    expect(result.contents).not.toBeNull();
    expect(result.contents!.startsWith(before.trimEnd())).toBe(true);
    expect(result.contents).toContain(CANONICAL_BLOCK);
  });

  it('replaces a legacy marker pair in place', () => {
    const before = `# Project\n\n${LEGACY_MARKER_STARTS[0]}\nold stuff\n${LEGACY_MARKER_ENDS[0]}\n\n## Custom notes below\n`;
    const result = applyInjectionReplacement(before, CANONICAL);
    expect(result.changed).toBe(true);
    expect(result.contents).not.toBeNull();
    expect(result.contents).toContain(CANONICAL_BLOCK);
    expect(result.contents).not.toContain(LEGACY_MARKER_STARTS[0]);
    expect(result.contents).toContain('## Custom notes below');
  });

  it('replaces a drifted block in place, preserving content above/below', () => {
    const stale = `${MARKER_START}\nstale guidance with shipped/ refs\n${MARKER_END}`;
    const before = `# Project\n\n${stale}\n\n## My Section\n\nLocal content.\n`;
    const result = applyInjectionReplacement(before, CANONICAL);
    expect(result.changed).toBe(true);
    expect(result.contents).not.toBeNull();
    expect(result.contents).toContain('# Project');
    expect(result.contents).toContain('## My Section');
    expect(result.contents).toContain('Local content.');
    expect(result.contents).toContain(CANONICAL_BLOCK);
    expect(result.contents).not.toContain('stale guidance with shipped/ refs');
  });

  it('is a no-op when the block is already in sync', () => {
    const before = `# Project\n\n${CANONICAL_BLOCK}\n`;
    const result = applyInjectionReplacement(before, CANONICAL);
    expect(result.changed).toBe(false);
    expect(result.contents).toBe(before);
    expect(result.state).toBe('in-sync');
  });

  it('repairs the motailz-style fixture to produce in-sync output', () => {
    const motailzBlock = [
      MARKER_START,
      '## MoFlo (old)',
      '',
      'For CLI commands, see:',
      '`.claude/guidance/shipped/moflo-core-guidance.md`',
      MARKER_END,
    ].join('\n');
    const before = `# Project\n\n${motailzBlock}\n`;

    const result = applyInjectionReplacement(before, CANONICAL);
    expect(result.changed).toBe(true);

    // Output: stale `shipped/` reference is gone, current flat reference is present.
    expect(result.contents).not.toContain('.claude/guidance/shipped/moflo-core-guidance.md');
    expect(result.contents).toContain('.claude/guidance/moflo-core-guidance.md');

    // Re-running computeInjectionDrift on the output yields 'in-sync'.
    const followup = computeInjectionDrift(result.contents, CANONICAL);
    expect(followup.state).toBe('in-sync');
  });

  it('replacement output is idempotent (second pass is a no-op)', () => {
    const before = `# Project\n\n${MARKER_START}\nstale\n${MARKER_END}\n`;
    const first = applyInjectionReplacement(before, CANONICAL);
    expect(first.changed).toBe(true);
    const second = applyInjectionReplacement(first.contents, CANONICAL);
    expect(second.changed).toBe(false);
    expect(second.contents).toBe(first.contents);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// formatInjectionDriftStatus
// ──────────────────────────────────────────────────────────────────────────

describe('formatInjectionDriftStatus', () => {
  it('produces a distinct message for each state', () => {
    const messages = new Set<string>();
    for (const state of ['no-file', 'no-marker', 'legacy-marker', 'in-sync', 'drifted'] as const) {
      messages.add(formatInjectionDriftStatus({ state }));
    }
    expect(messages.size).toBe(5);
  });
});
