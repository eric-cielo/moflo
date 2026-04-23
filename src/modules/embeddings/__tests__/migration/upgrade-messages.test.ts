/**
 * Snapshot + regex tests for user-facing upgrade UX copy.
 *
 * Anything the orchestrator or renderer prints during a default (non-verbose)
 * run flows through this module, so the tests here are the contract for
 * user-facing language. Technical jargon is explicitly banned.
 */
import { describe, it, expect } from 'vitest';

import {
  announcement,
  BANNED_TECHNICAL_TERMS,
  batchExhaustionFailure,
  estimateMinutes,
  finalSuccess,
  formatDuration,
  pauseOnInterrupt,
  retryingBatch,
  stepCompleted,
} from '../../src/migration/upgrade-messages.js';

const ALL_STRINGS = (): string[] => [
  announcement({
    steps: [
      { label: 'Re-index memory database', itemsTotal: 341 },
      { label: 'Re-index guidance shards', itemsTotal: 128 },
    ],
    estimatedMinutes: 2,
  }),
  announcement({
    steps: [{ label: 'Re-index memory database', itemsTotal: 5 }],
    estimatedMinutes: 0,
    resumed: { itemsDone: 40, itemsTotal: 341 },
  }),
  stepCompleted(1, 3, 'Re-index memory database', 341),
  finalSuccess(469, 185_000),
  pauseOnInterrupt(80, 341),
  batchExhaustionFailure('Re-index memory database'),
  retryingBatch('Re-index memory database', 2),
];

describe('upgrade-messages', () => {
  describe('announcement', () => {
    it('matches snapshot for multi-step plan with a 2-minute estimate', () => {
      expect(
        announcement({
          steps: [
            { label: 'Re-index memory database', itemsTotal: 341 },
            { label: 'Re-index guidance shards', itemsTotal: 128 },
          ],
          estimatedMinutes: 2,
        }),
      ).toMatchInlineSnapshot(`
        "Upgrading moflo memory for better semantic search

        Your existing memory was built with older, lower-quality search data.
        We're rebuilding it so search finds what you mean, not just what you
        type.

        Steps:
          1. Re-index memory database (341 items)
          2. Re-index guidance shards (128 items)

        Estimated time: about 2 minutes. Safe to interrupt — we'll pick up next time."
      `);
    });

    it('matches snapshot when resuming and estimate is under a minute', () => {
      expect(
        announcement({
          steps: [{ label: 'Re-index memory database', itemsTotal: 5 }],
          estimatedMinutes: 0,
          resumed: { itemsDone: 40, itemsTotal: 341 },
        }),
      ).toMatchInlineSnapshot(`
        "Upgrading moflo memory for better semantic search

        Your existing memory was built with older, lower-quality search data.
        We're rebuilding it so search finds what you mean, not just what you
        type.

        Resuming where we left off: 40 of 341 items already done.

        Steps:
          1. Re-index memory database (5 items)

        Estimated time: less than a minute. Safe to interrupt — we'll pick up next time."
      `);
    });

    it('uses singular phrasing for a 1-minute estimate', () => {
      const text = announcement({
        steps: [{ label: 'Re-index memory database', itemsTotal: 50 }],
        estimatedMinutes: 1,
      });
      expect(text).toContain('about 1 minute.');
      expect(text).not.toContain('about 1 minutes');
    });
  });

  describe('step + final copy', () => {
    it('stepCompleted matches snapshot', () => {
      expect(stepCompleted(1, 3, 'Re-index memory database', 341)).toMatchInlineSnapshot(
        `"✓ Step 2/3 complete — Re-index memory database (341 items)"`,
      );
    });

    it('finalSuccess formats minutes+seconds when duration > 60s', () => {
      expect(finalSuccess(469, 185_000)).toMatchInlineSnapshot(
        `"✓ Memory upgrade complete — 469 items re-indexed in 3m 5s."`,
      );
    });

    it('finalSuccess omits seconds when duration is a whole minute', () => {
      expect(finalSuccess(100, 120_000)).toBe(
        '✓ Memory upgrade complete — 100 items re-indexed in 2m.',
      );
    });

    it('finalSuccess uses seconds-only for sub-minute durations', () => {
      expect(finalSuccess(10, 4_800)).toBe(
        '✓ Memory upgrade complete — 10 items re-indexed in 4s.',
      );
    });

    it('pauseOnInterrupt matches snapshot', () => {
      expect(pauseOnInterrupt(80, 341)).toMatchInlineSnapshot(
        `"Paused. Will resume automatically next time moflo runs. (80 of 341 items done.)"`,
      );
    });

    it('batchExhaustionFailure matches snapshot', () => {
      expect(batchExhaustionFailure('Re-index memory database')).toMatchInlineSnapshot(
        `"Upgrade failed while re-indexing "Re-index memory database". Retry runs next time moflo starts. For details, set MOFLO_UPGRADE_VERBOSE=1."`,
      );
    });

    it('retryingBatch matches snapshot', () => {
      expect(retryingBatch('Re-index memory database', 2)).toMatchInlineSnapshot(
        `"Retrying "Re-index memory database" (attempt 2)..."`,
      );
    });
  });

  describe('banned technical terms', () => {
    it('default-path output contains none of the banned terms', () => {
      const banned = new RegExp(`\\b(${BANNED_TECHNICAL_TERMS.join('|')})\\b`, 'i');
      for (const text of ALL_STRINGS()) {
        expect(text).not.toMatch(banned);
      }
    });
  });

  describe('estimateMinutes', () => {
    it('returns 0 for empty input', () => {
      expect(estimateMinutes(0)).toBe(0);
      expect(estimateMinutes(-1)).toBe(0);
    });

    it('rounds a 200-item plan at 100/s to 0 minutes (under a minute)', () => {
      expect(estimateMinutes(200, 100)).toBe(0);
    });

    it('rounds a 6000-item plan at 100/s to 1 minute', () => {
      expect(estimateMinutes(6000, 100)).toBe(1);
    });

    it('tolerates invalid throughput without dividing by zero', () => {
      expect(estimateMinutes(1000, 0)).toBe(0);
    });
  });

  describe('formatDuration', () => {
    it.each([
      [0, '0s'],
      [900, '0s'],
      [1_000, '1s'],
      [59_000, '59s'],
      [60_000, '1m'],
      [61_000, '1m 1s'],
      [3_661_000, '61m 1s'],
    ])('%d ms -> %s', (ms, expected) => {
      expect(formatDuration(ms)).toBe(expected);
    });
  });
});
