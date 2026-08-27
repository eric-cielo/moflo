/**
 * Tests for scripts/test-runner-failures.mjs
 *
 * Covers the failure-extraction logic that #642 relies on so a flake
 * always names the responsible test file/name in the summary, even when
 * vitest's default reporter output has scrolled past in a tail buffer.
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyOutcome, extractFailures, printFailures } from '../../scripts/test-runner-failures.mjs';

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

/**
 * `npm test` announced "All tests passed" and exited 0 on a run vitest had
 * already failed (#1468 follow-up).
 *
 * The wrapper read only the JSON results, which is correct for *test* failures
 * — vitest exits non-zero on an OOM'd worker fork with everything green, which
 * is why the exit code alone was never trusted. But the JSON cannot express an
 * unhandled rejection escaping a test: vitest exits 1 and prints the error while
 * the results report `numFailedTests: 0`, `numFailedTestSuites: 0` and
 * `success: true`. Verified against real vitest output before this was written.
 *
 * Both signals now have to agree. The shapes below are the four the runner can
 * actually see; the third is the one that used to pass.
 */
describe('classifyOutcome', () => {
  const failure = { file: '/abs/a.test.ts', name: 'a > fails' };

  it('is clean when every pass exited 0 with no failures', () => {
    const outcome = classifyOutcome([
      { label: 'parallel suite', code: 0, failures: [], verified: true },
      { label: 'isolation batch', code: 0, failures: [], verified: true },
    ]);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe('clean');
    expect(outcome.faults).toEqual([]);
  });

  it('reports named test failures as test-failures', () => {
    const outcome = classifyOutcome([{ label: 'parallel suite', code: 1, failures: [failure] }]);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('test-failures');
    expect(outcome.failures).toEqual([failure]);
  });

  it('fails a non-zero exit that named no failing test', () => {
    // The regression. An unhandled rejection lands here: exit 1, zero failures.
    const outcome = classifyOutcome([{ label: 'parallel suite', code: 1, failures: [] }]);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('runner-fault');
    expect(outcome.faults).toEqual([{ label: 'parallel suite', code: 1, cause: 'nonzero-exit' }]);
  });

  it('faults a pass whose results file was unreadable, even on a zero exit', () => {
    // vitest exited 0 but left no results to inspect. The wrapper verified
    // nothing, and used to call that a clean run with zero tests passed.
    const outcome = classifyOutcome([
      { label: 'parallel suite', code: 0, failures: [], verified: false },
    ]);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('runner-fault');
    expect(outcome.faults).toEqual([
      { label: 'parallel suite', code: 0, cause: 'results-unreadable' },
    ]);
  });

  it('does not fault a pass that read its results cleanly', () => {
    const outcome = classifyOutcome([
      { label: 'parallel suite', code: 0, failures: [], verified: true },
    ]);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe('clean');
  });

  it('names the pass that faulted, not just that one did', () => {
    const outcome = classifyOutcome([
      { label: 'parallel suite', code: 0, failures: [] },
      { label: 'isolation batch', code: 1, failures: [] },
    ]);

    expect(outcome.faults).toEqual([{ label: 'isolation batch', code: 1, cause: 'nonzero-exit' }]);
  });

  it('downgrades a fault to a pass under MOFLO_TEST_TOLERATE_RUNNER_EXIT', () => {
    const outcome = classifyOutcome([{ label: 'parallel suite', code: 1, failures: [] }], {
      tolerateRunnerExit: true,
    });

    // Still reported, still visible — the escape hatch exists for the OOM case
    // the exit code cannot be told apart from, not to make the signal vanish.
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe('tolerated-runner-fault');
    expect(outcome.faults).toEqual([{ label: 'parallel suite', code: 1, cause: 'nonzero-exit' }]);
  });

  it('never lets the escape hatch suppress a real test failure', () => {
    const outcome = classifyOutcome([{ label: 'parallel suite', code: 1, failures: [failure] }], {
      tolerateRunnerExit: true,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('test-failures');
  });

  it('prefers the test list when a pass both failed tests and exited non-zero', () => {
    const outcome = classifyOutcome([
      { label: 'parallel suite', code: 1, failures: [failure] },
      { label: 'isolation batch', code: 1, failures: [] },
    ]);

    // The operator needs the named test first; the fault is still carried so the
    // runner can print it, but it must not displace the failure list.
    expect(outcome.reason).toBe('test-failures');
    expect(outcome.failures).toEqual([failure]);
    expect(outcome.faults).toHaveLength(2);
  });

  it('tolerates a malformed pass list rather than throwing mid-summary', () => {
    expect(classifyOutcome([]).ok).toBe(true);
    expect(classifyOutcome(undefined as never).ok).toBe(true);
    expect(classifyOutcome([null as never, { label: 'x', code: 0 }]).ok).toBe(true);
  });
});
