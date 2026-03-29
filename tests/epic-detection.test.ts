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
} from '../src/packages/cli/src/epic/detection.js';
import { resolveExecutionOrder } from '../src/packages/cli/src/epic/execution-order.js';
import type { GitHubIssue, StoryDefinition } from '../src/packages/cli/src/epic/types.js';

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
// resolveExecutionOrder
// ============================================================================

describe('resolveExecutionOrder', () => {
  it('returns sequential order for independent stories', () => {
    const stories: StoryDefinition[] = [
      { id: 'a', name: 'A', issue: 1 },
      { id: 'b', name: 'B', issue: 2 },
      { id: 'c', name: 'C', issue: 3 },
    ];
    const plan = resolveExecutionOrder(stories);
    expect(plan.order).toEqual(['a', 'b', 'c']);
    expect(plan.independent_groups).toEqual([['a', 'b', 'c']]);
  });

  it('respects dependencies', () => {
    const stories: StoryDefinition[] = [
      { id: 'a', name: 'A', issue: 1 },
      { id: 'b', name: 'B', issue: 2, depends_on: ['a'] },
      { id: 'c', name: 'C', issue: 3, depends_on: ['b'] },
    ];
    const plan = resolveExecutionOrder(stories);
    expect(plan.order).toEqual(['a', 'b', 'c']);
    expect(plan.independent_groups).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups independent stories at same level', () => {
    const stories: StoryDefinition[] = [
      { id: 'a', name: 'A', issue: 1 },
      { id: 'b', name: 'B', issue: 2 },
      { id: 'c', name: 'C', issue: 3, depends_on: ['a', 'b'] },
    ];
    const plan = resolveExecutionOrder(stories);
    expect(plan.order).toEqual(['a', 'b', 'c']);
    expect(plan.independent_groups).toHaveLength(2);
    expect(plan.independent_groups[0]).toEqual(['a', 'b']);
    expect(plan.independent_groups[1]).toEqual(['c']);
  });

  it('detects circular dependencies', () => {
    const stories: StoryDefinition[] = [
      { id: 'a', name: 'A', issue: 1, depends_on: ['b'] },
      { id: 'b', name: 'B', issue: 2, depends_on: ['a'] },
    ];
    expect(() => resolveExecutionOrder(stories)).toThrow('Circular dependency');
  });

  it('handles diamond dependencies', () => {
    const stories: StoryDefinition[] = [
      { id: 'a', name: 'A', issue: 1 },
      { id: 'b', name: 'B', issue: 2, depends_on: ['a'] },
      { id: 'c', name: 'C', issue: 3, depends_on: ['a'] },
      { id: 'd', name: 'D', issue: 4, depends_on: ['b', 'c'] },
    ];
    const plan = resolveExecutionOrder(stories);
    expect(plan.order[0]).toBe('a');
    expect(plan.order[plan.order.length - 1]).toBe('d');
    expect(plan.independent_groups[0]).toEqual(['a']);
    expect(plan.independent_groups[1]).toContain('b');
    expect(plan.independent_groups[1]).toContain('c');
  });

  it('handles empty input', () => {
    const plan = resolveExecutionOrder([]);
    expect(plan.order).toEqual([]);
    expect(plan.independent_groups).toEqual([]);
  });
});
