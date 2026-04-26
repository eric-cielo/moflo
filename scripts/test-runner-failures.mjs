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

export function printFailures(label, failures, log = console.log) {
  if (failures.length === 0) return;
  log(`\n  Failed in ${label}:`);
  for (const f of failures) {
    log(`    ✗ ${f.file}`);
    log(`        ${f.name}`);
  }
}
