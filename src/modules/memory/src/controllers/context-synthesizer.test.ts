import { describe, it, expect } from 'vitest';
import { ContextSynthesizer } from './context-synthesizer.js';

describe('ContextSynthesizer', () => {
  it('returns empty-friendly result when no memories are supplied', () => {
    const r = ContextSynthesizer.synthesize([]);
    expect(r.count).toBe(0);
    expect(r.successCount).toBe(0);
    expect(r.failureCount).toBe(0);
    expect(r.topKeys).toEqual([]);
    expect(r.summary).toMatch(/no memor/i);
    expect(r.recommendations).toEqual([]);
  });

  it('handles null and invalid input gracefully', () => {
    expect(ContextSynthesizer.synthesize(null).count).toBe(0);
    expect(ContextSynthesizer.synthesize(undefined).count).toBe(0);
    expect(ContextSynthesizer.synthesize([{ content: '', key: 'x' } as any]).count).toBe(0);
  });

  it('counts success and failure verdicts', () => {
    const r = ContextSynthesizer.synthesize([
      { content: 'a', key: 'k-1', verdict: 'success' },
      { content: 'b', key: 'k-2', verdict: 'failure' },
      { content: 'c', key: 'k-3', verdict: 'success' },
      { content: 'd', key: 'k-4' },
    ]);
    expect(r.successCount).toBe(2);
    expect(r.failureCount).toBe(1);
    expect(r.count).toBe(4);
  });

  it('sorts top keys by reward descending', () => {
    const r = ContextSynthesizer.synthesize([
      { content: 'a', key: 'low', reward: 0.1 },
      { content: 'b', key: 'high', reward: 0.9 },
      { content: 'c', key: 'mid', reward: 0.5 },
    ]);
    expect(r.topKeys.slice(0, 3)).toEqual(['high', 'mid', 'low']);
  });

  it('respects maxContent budget', () => {
    const big = 'x'.repeat(2000);
    const r = ContextSynthesizer.synthesize(
      [
        { content: big, key: 'a' },
        { content: big, key: 'b' },
      ],
      { maxContent: 300 },
    );
    // Summary should be reasonably bounded (header + excerpts + newlines).
    expect(r.summary.length).toBeLessThan(800);
  });

  it('omits recommendations when includeRecommendations is false', () => {
    const r = ContextSynthesizer.synthesize(
      [{ content: 'a', key: 'k', verdict: 'success' }],
      { includeRecommendations: false },
    );
    expect(r.recommendations).toBeUndefined();
  });

  it('includes actionable recommendation text by default', () => {
    const r = ContextSynthesizer.synthesize([
      { content: 'a', key: 'k-ok', verdict: 'success', reward: 0.9 },
      { content: 'b', key: 'k-bad', verdict: 'failure' },
    ]);
    expect(r.recommendations && r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations?.some((s) => s.includes('successful'))).toBe(true);
    expect(r.recommendations?.some((s) => s.includes('failure'))).toBe(true);
  });
});
