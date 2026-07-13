/**
 * Epic Detection & Extraction Tests
 *
 * Story #195: Tests for shared epic detection module.
 */

import { describe, it, expect } from 'vitest';
import {
  isEpicIssue,
  extractStories,
  extractUncheckedStories,
  computeEpicCheckoff,
} from '../src/cli/epic/detection.js';
import type { GitHubIssue } from '../src/cli/epic/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: 'Test Epic',
    body: '',
    labels: [],
    state: 'OPEN',
    ...overrides,
  };
}

// ============================================================================
// isEpicIssue
// ============================================================================

describe('isEpicIssue', () => {
  it('detects epic label', () => {
    expect(isEpicIssue(makeIssue({ labels: [{ name: 'epic' }] }))).toBe(true);
  });

  it('detects tracking label (case-insensitive)', () => {
    expect(isEpicIssue(makeIssue({ labels: [{ name: 'Tracking' }] }))).toBe(true);
  });

  it('detects parent label', () => {
    expect(isEpicIssue(makeIssue({ labels: [{ name: 'parent' }] }))).toBe(true);
  });

  it('detects umbrella label', () => {
    expect(isEpicIssue(makeIssue({ labels: [{ name: 'umbrella' }] }))).toBe(true);
  });

  it('detects ## Stories section', () => {
    expect(isEpicIssue(makeIssue({ body: '## Stories\n- [ ] #1' }))).toBe(true);
  });

  it('detects ## Tasks section', () => {
    expect(isEpicIssue(makeIssue({ body: '## Tasks\n- [ ] #1' }))).toBe(true);
  });

  it('detects checklist-linked issues', () => {
    expect(isEpicIssue(makeIssue({ body: '- [ ] #123\n- [x] #124' }))).toBe(true);
  });

  it('detects numbered issue references', () => {
    expect(isEpicIssue(makeIssue({ body: '1. #123\n2. #124' }))).toBe(true);
  });

  it('returns false for regular issue', () => {
    expect(isEpicIssue(makeIssue({ body: 'Just a regular bug report' }))).toBe(false);
  });

  it('returns false for empty body', () => {
    expect(isEpicIssue(makeIssue({ body: '' }))).toBe(false);
  });
});

// ============================================================================
// extractStories
// ============================================================================

describe('extractStories', () => {
  it('extracts from checklist format', () => {
    const issue = makeIssue({
      body: '## Stories\n\n- [ ] #193 — Prerequisites\n- [ ] #194 — GitHub command\n- [x] #195 — Detection',
    });
    const stories = extractStories(issue);
    expect(stories).toHaveLength(3);
    expect(stories.map(s => s.issue)).toEqual([193, 194, 195]);
  });

  it('extracts from numbered format', () => {
    const issue = makeIssue({
      body: '1. #10 First story\n2. #20 Second story',
    });
    const stories = extractStories(issue);
    expect(stories).toHaveLength(2);
    expect(stories.map(s => s.issue)).toEqual([10, 20]);
  });

  it('extracts bare references from Stories section', () => {
    const issue = makeIssue({
      body: '## Stories\nWe need #5 and #6 done first.\n\n## Other',
    });
    const stories = extractStories(issue);
    expect(stories).toHaveLength(2);
    expect(stories.map(s => s.issue)).toEqual([5, 6]);
  });

  it('deduplicates by issue number', () => {
    const issue = makeIssue({
      body: '- [ ] #100\n- [ ] #100\n1. #100',
    });
    const stories = extractStories(issue);
    expect(stories).toHaveLength(1);
    expect(stories[0].issue).toBe(100);
  });

  it('returns empty for no references', () => {
    const stories = extractStories(makeIssue({ body: 'No issues here' }));
    expect(stories).toHaveLength(0);
  });

  it('sets default name', () => {
    const stories = extractStories(makeIssue({ body: '- [ ] #42' }));
    expect(stories[0].name).toBe('Issue #42');
    expect(stories[0].id).toBe('story-42');
  });
});

// ============================================================================
// extractUncheckedStories
// ============================================================================

describe('extractUncheckedStories', () => {
  it('returns only unchecked stories', () => {
    const issue = makeIssue({
      body: '- [ ] #1\n- [x] #2\n- [ ] #3\n- [x] #4',
    });
    const unchecked = extractUncheckedStories(issue);
    expect(unchecked).toEqual([1, 3]);
  });

  it('returns empty for all checked', () => {
    const issue = makeIssue({ body: '- [x] #1\n- [x] #2' });
    expect(extractUncheckedStories(issue)).toEqual([]);
  });
});

// ============================================================================
// computeEpicCheckoff (pure core of `flo epic checkoff`)
// ============================================================================

describe('computeEpicCheckoff', () => {
  const epicBody = '## Stories\n\n- [ ] #101 — First\n- [ ] #102 — Second\n- [ ] #103 — Third';

  it('flips the targeted story box and reports it checked', () => {
    const { updated, checked } = computeEpicCheckoff(epicBody, 102);
    expect(checked).toBe(true);
    expect(updated).toContain('- [x] #102 — Second');
    expect(updated).toContain('- [ ] #101 — First');
    expect(updated).toContain('- [ ] #103 — Third');
  });

  it('does not mark complete while other stories remain unchecked', () => {
    expect(computeEpicCheckoff(epicBody, 102).allComplete).toBe(false);
  });

  it('marks complete when the last unchecked story is flipped', () => {
    const body = '- [x] #101\n- [x] #102\n- [ ] #103';
    const { checked, allComplete } = computeEpicCheckoff(body, 103);
    expect(checked).toBe(true);
    expect(allComplete).toBe(true);
  });

  it('is idempotent — an already-checked story is not re-flipped', () => {
    const body = '- [x] #101\n- [ ] #102';
    const { updated, checked, allComplete } = computeEpicCheckoff(body, 101);
    expect(checked).toBe(false);
    expect(updated).toBe(body);
    expect(allComplete).toBe(false); // #102 still open
  });

  it('respects word boundaries — #12 does not match #123', () => {
    const body = '- [ ] #12\n- [ ] #123';
    const { updated } = computeEpicCheckoff(body, 12);
    expect(updated).toContain('- [x] #12\n');
    expect(updated).toContain('- [ ] #123');
  });

  it('does not treat a checkbox-less epic as complete (no false close)', () => {
    // Bare `## Stories` refs, no `- [ ]` boxes — flipping nothing must not
    // report allComplete, or the CLI would close an epic with open work.
    const body = '## Stories\nWe still need #5 and #6.';
    const { checked, allComplete } = computeEpicCheckoff(body, 5);
    expect(checked).toBe(false);
    expect(allComplete).toBe(false);
  });

  it('reports complete when the target story is already the only checked box left', () => {
    const body = '- [x] #101\n- [x] #102';
    const { checked, allComplete } = computeEpicCheckoff(body, 101);
    expect(checked).toBe(false); // already checked
    expect(allComplete).toBe(true); // nothing unchecked remains
  });
});
