/**
 * Failure-extraction helpers for the test-runner wrapper.
 *
 * Lives in its own module so tests can import without triggering the
 * runner's top-level main() side effect.
 */

/** Pull failed test ids out of vitest's JSON results so the summary line
 *  still names them when the default reporter's output has scrolled past
 *  in a tail buffer. Without this, a transient flake leaves zero forensic
 *  trace once `.vitest-results.json` gets clobbered by the next run (#642). */
export function extractFailures(results) {
  const failures = [];
  const testFiles = results?.testResults || [];
  for (const file of testFiles) {
    const fileName = file.name || '(unknown file)';
    const assertions = file.assertionResults || [];
    const failedAssertions = assertions.filter((a) => a.status === 'failed');
    for (const a of failedAssertions) {
      failures.push({ file: fileName, name: a.fullName || a.title || '(unnamed)' });
    }
    if (failedAssertions.length === 0 && file.status === 'failed') {
      // File-level failure with no per-assertion record (import error, setup
      // hook crash, suite-level throw). Surface the file so the operator can
      // re-run it directly.
      failures.push({ file: fileName, name: '(file-level failure: import / setup / suite hook)' });
    }
  }
  return failures;
}

/**
 * Decide whether a completed run is clean.
 *
 * Two independent signals have to agree, because neither one is sufficient:
 *
 * - **The JSON results** name which tests failed. This is the authority on
 *   *test* failures, and the reason a bare exit code was never enough: vitest
 *   exits non-zero when a worker fork dies (OOM), even with every test green.
 * - **vitest's exit code**, which catches everything the results file cannot
 *   express. An unhandled rejection escaping a test is the case that motivated
 *   this (#1468 follow-up): vitest exits 1 and prints the error, while the JSON
 *   reports `numFailedTests: 0`, `numFailedTestSuites: 0` and `success: true`.
 *   Reading only the JSON, the wrapper announced "All tests passed" and exited
 *   0 — so CI went green on a run vitest had already failed.
 *
 * Trusting only the JSON hides that class entirely; trusting only the exit code
 * brings back the OOM false alarm. So a non-zero exit with no named failures is
 * reported as its own outcome — a **runner fault** — rather than being either
 * swallowed or mislabelled as a test failure. It fails the run, because a red
 * signal is not background noise, and `MOFLO_TEST_TOLERATE_RUNNER_EXIT=1` is the
 * documented way through for someone genuinely chasing the OOM case.
 *
 * A pass whose results file could not be read is a fault for the same reason,
 * even when vitest exited 0: the wrapper verified nothing, and reporting success
 * for a run it could not inspect is the very thing this function exists to stop.
 *
 * @param passes  One entry per vitest invocation:
 *                `{ label, code, failures, verified }`. `verified: false` means
 *                the results file was missing or unparseable.
 * @param options `tolerateRunnerExit` downgrades a runner fault to a warning.
 */
export function classifyOutcome(passes, { tolerateRunnerExit = false } = {}) {
  const list = Array.isArray(passes) ? passes : [];
  const failures = list.flatMap((p) => p?.failures || []);
  const faults = list
    .filter((p) => p && (p.code !== 0 || p.verified === false))
    .map((p) => ({
      label: p.label || '(unnamed pass)',
      code: p.code,
      cause: p.verified === false ? 'results-unreadable' : 'nonzero-exit',
    }));

  // Named test failures outrank a fault: the operator needs the test list, and
  // a failing test is itself the most likely reason for the non-zero exit.
  if (failures.length > 0) return { ok: false, reason: 'test-failures', failures, faults };
  if (faults.length > 0) {
    return tolerateRunnerExit
      ? { ok: true, reason: 'tolerated-runner-fault', failures, faults }
      : { ok: false, reason: 'runner-fault', failures, faults };
  }
  return { ok: true, reason: 'clean', failures, faults };
}

export function printFailures(label, failures, log = console.log) {
  if (failures.length === 0) return;
  log(`\n  Failed in ${label}:`);
  for (const f of failures) {
    log(`    ✗ ${f.file}`);
    log(`        ${f.name}`);
  }
}
