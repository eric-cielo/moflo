/**
 * Tests for scripts/test-runner-failures.mjs
 *
 * Covers the failure-extraction logic that #642 relies on so a flake
 * always names the responsible test file/name in the summary, even when
 * vitest's default reporter output has scrolled past in a tail buffer.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractFailures, printFailures } from '../../scripts/test-runner-failures.mjs';

describe('extractFailures', () => {
  it('returns [] for an empty / clean run', () => {
    expect(extractFailures({ testResults: [] })).toEqual([]);
    expect(extractFailures({})).toEqual([]);
    expect(extractFailures(null)).toEqual([]);
    expect(extractFailures(undefined)).toEqual([]);
  });

  it('returns [] when every assertion passed', () => {
    const results = {
      testResults: [
        {
          name: '/abs/path/foo.test.ts',
          status: 'passed',
          assertionResults: [
            { title: 'a', status: 'passed' },
            { title: 'b', status: 'passed' },
          ],
        },
      ],
    };
    expect(extractFailures(results)).toEqual([]);
  });

  it('captures one entry per failed assertion with file + fullName', () => {
    const results = {
      testResults: [
        {
          name: '/abs/path/foo.test.ts',
          status: 'failed',
          assertionResults: [
            { fullName: 'foo > a', title: 'a', status: 'passed' },
            { fullName: 'foo > b', title: 'b', status: 'failed' },
            { fullName: 'foo > c', title: 'c', status: 'failed' },
          ],
        },
        {
          name: '/abs/path/bar.test.ts',
          status: 'failed',
          assertionResults: [
            { fullName: 'bar > x', title: 'x', status: 'failed' },
          ],
        },
      ],
    };
    expect(extractFailures(results)).toEqual([
      { file: '/abs/path/foo.test.ts', name: 'foo > b' },
      { file: '/abs/path/foo.test.ts', name: 'foo > c' },
      { file: '/abs/path/bar.test.ts', name: 'bar > x' },
    ]);
  });

  it('falls back to title when fullName is missing', () => {
    const results = {
      testResults: [
        {
          name: '/abs/path/foo.test.ts',
          status: 'failed',
          assertionResults: [{ title: 'just-title', status: 'failed' }],
        },
      ],
    };
    expect(extractFailures(results)).toEqual([
      { file: '/abs/path/foo.test.ts', name: 'just-title' },
    ]);
  });

  it('records a file-level failure when status=failed but no assertion failed', () => {
    // Import error / setup hook crash — vitest reports the file as failed
    // without per-assertion failure records.
    const results = {
      testResults: [
        {
          name: '/abs/path/broken.test.ts',
          status: 'failed',
          assertionResults: [],
        },
      ],
    };
    const out = extractFailures(results);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('/abs/path/broken.test.ts');
    expect(out[0].name).toMatch(/file-level failure/);
  });

  it('handles a missing file name defensively', () => {
    const results = {
      testResults: [
        { status: 'failed', assertionResults: [{ title: 't', status: 'failed' }] },
      ],
    };
    expect(extractFailures(results)).toEqual([
      { file: '(unknown file)', name: 't' },
    ]);
  });
});

describe('printFailures', () => {
  it('writes nothing when the failure list is empty', () => {
    const log = vi.fn();
    printFailures('parallel suite', [], log);
    expect(log).not.toHaveBeenCalled();
  });

  it('emits a header plus two lines per failure (file + name)', () => {
    const log = vi.fn();
    printFailures('parallel suite', [
      { file: '/abs/foo.test.ts', name: 'foo > b' },
      { file: '/abs/bar.test.ts', name: 'bar > x' },
    ], log);

    // 1 header + 2 lines per failure
    expect(log).toHaveBeenCalledTimes(1 + 2 * 2);
    const calls = log.mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatch(/parallel suite/);
    expect(calls.join('\n')).toContain('/abs/foo.test.ts');
    expect(calls.join('\n')).toContain('foo > b');
    expect(calls.join('\n')).toContain('/abs/bar.test.ts');
    expect(calls.join('\n')).toContain('bar > x');
  });
});
