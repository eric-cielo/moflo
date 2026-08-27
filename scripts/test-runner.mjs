#!/usr/bin/env node
/**
 * Test runner wrapper for vitest.
 *
 * 1. Runs the main parallel suite (excludes isolation tests).
 * 2. Runs each isolation test sequentially — these pass alone but
 *    timeout under full-suite resource contention.
 * 3. Exits 0 only if both passes succeed.
 *
 * Vitest exits 1 when worker forks crash (OOM), even if every test passes, so
 * the JSON results — not the exit code — are the authority on which tests
 * failed. The exit code is still read, because the JSON cannot express every
 * way a run goes wrong: an unhandled rejection escaping a test makes vitest
 * exit 1 while the results file reports zero failures and `success: true`.
 * Reading only the JSON, this wrapper printed "All tests passed" and exited 0
 * on a run vitest had already failed. See `classifyOutcome` in
 * ./test-runner-failures.mjs for the policy and the escape hatch.
 */

import { spawn } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadIsolationTests } from './load-isolation-tests.mjs';
import { classifyOutcome, extractFailures, printFailures } from './test-runner-failures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const jsonFile = resolve(root, '.vitest-results.json');
const vitestBin = resolve(root, 'node_modules/vitest/vitest.mjs');
const isolationConfig = resolve(root, 'vitest.isolation.config.ts');
const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };

/** Run vitest with given args, return { label, code, passed, failed, failures } */
function runVitest(label, args, { config } = {}) {
  const finalArgs = [vitestBin, ...args];
  if (config) finalArgs.push('--config', config);

  // Clear the results file BEFORE the run, not only after. A previous run
  // interrupted at the terminal never reaches its own cleanup, and a vitest
  // that then dies before writing would leave this reading the last run's
  // green results and calling the dead one clean.
  cleanup();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, finalArgs, {
      stdio: 'inherit',
      env,
      cwd: root,
    });

    child.on('close', (code) => {
      let passed = 0;
      let failed = 0;
      let failures = [];
      let verified = false;

      try {
        const raw = readFileSync(jsonFile, 'utf-8');
        const results = JSON.parse(raw);
        failures = extractFailures(results);
        // Count the failures we can actually name, so the number and the list
        // below it agree. `numFailedTests + numFailedTestSuites` did not:
        // vitest counts the file AND each enclosing describe as suites, so one
        // failing test reported "Total failed: 3".
        failed = failures.length;
        passed = results.numPassedTests || 0;
        verified = true;
      } catch {
        // Results unreadable. `verified` stays false, which classifyOutcome
        // treats as a fault on its own — a vitest that exits 0 without leaving
        // results behind has told us nothing, and the old code called that a
        // clean run with zero tests passed.
        if (code !== 0) failed = 1;
      }

      cleanup();
      resolve({ label, code, passed, failed, failures, verified });
    });
  });
}

function cleanup() {
  try { unlinkSync(jsonFile); } catch { /* ok */ }
}

async function main() {
  const isolationTests = loadIsolationTests(resolve(root, 'vitest.config.ts'));

  // ── Pass 1: Main parallel suite ──
  console.log('\n━━ Pass 1: Parallel suite ━━\n');
  const main = await runVitest('parallel suite', [
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${jsonFile}`,
  ]);

  let totalPassed = main.passed;
  let totalFailed = main.failed;
  const allFailures = [...main.failures];
  const passes = [main];

  if (main.failed > 0) {
    console.log(`\n✗ Parallel suite: ${main.failed} failure(s)`);
    printFailures('parallel suite', main.failures);
  } else {
    console.log(`\n✓ Parallel suite: ${main.passed} tests passed`);
  }

  // ── Pass 2: Isolation tests (single batch, serialized via maxForks:1) ──
  //
  // Previously this spawned one vitest process per file. Each cold-boot
  // costs 3-6s for ts-node + plugin + transform setup, adding 30-60s of
  // pure startup overhead across the list. A single invocation with
  // maxForks:1 gives us the same one-at-a-time execution with a single
  // cold-boot, typically cutting Pass 2 wall time in half.
  //
  // Dev escape hatch: MOFLO_TEST_SKIP_ISOLATION=1 skips Pass 2 entirely for
  // rapid iteration. Pre-publish, /publish runs the unflagged suite — so
  // this never lets a bad isolation test slip into a release.
  const skipIsolation = process.env.MOFLO_TEST_SKIP_ISOLATION === '1';
  const presentIsolationTests = isolationTests.filter((t) => {
    if (existsSync(resolve(root, t))) return true;
    console.log(`  ⚠ skipped (not found): ${t}`);
    return false;
  });

  if (skipIsolation && presentIsolationTests.length > 0) {
    console.log(
      `\n⚠ Skipping Pass 2: ${presentIsolationTests.length} isolation test file(s) ` +
      `(MOFLO_TEST_SKIP_ISOLATION=1 — dev only, do not use pre-publish)`
    );
  } else if (presentIsolationTests.length > 0) {
    console.log(`\n━━ Pass 2: Isolation tests (${presentIsolationTests.length} files, single batch) ━━\n`);

    const result = await runVitest('isolation batch', [
      'run',
      ...presentIsolationTests,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${jsonFile}`,
    ], { config: isolationConfig });

    totalPassed += result.passed;
    totalFailed += result.failed;
    allFailures.push(...result.failures);
    passes.push(result);

    if (result.failed > 0) {
      console.log(`\n✗ Isolation batch: ${result.failed} failure(s)`);
      printFailures('isolation batch', result.failures);
    } else {
      console.log(`\n✓ Isolation batch: ${result.passed} tests passed`);
    }
  }

  // ── Summary ──
  const tolerateRunnerExit = process.env.MOFLO_TEST_TOLERATE_RUNNER_EXIT === '1';
  const outcome = classifyOutcome(passes, { tolerateRunnerExit });

  console.log('\n━━ Summary ━━');
  console.log(`  Total passed: ${totalPassed}`);
  console.log(`  Total failed: ${totalFailed}`);

  if (outcome.reason === 'test-failures') {
    printFailures('full run', allFailures);
    console.log('\n✗ Tests failed');
    process.exit(1);
  }

  if (outcome.faults.length > 0) {
    // No test is named, so say plainly what happened and where to look — the
    // detail is in vitest's own output above, which the default reporter has
    // already printed (commonly under "Unhandled Errors").
    console.log('\n  A pass could not be confirmed clean:');
    for (const fault of outcome.faults) {
      console.log(
        fault.cause === 'results-unreadable'
          ? `    ✗ ${fault.label} — exit code ${fault.code}, and its results file was unreadable`
          : `    ✗ ${fault.label} — exit code ${fault.code}`
      );
    }
    console.log('  Scroll up for vitest\'s own output — an unhandled rejection,');
    console.log('  a crashed worker, or a setup failure. Set');
    console.log('  MOFLO_TEST_TOLERATE_RUNNER_EXIT=1 to downgrade this to a warning.');
  }

  if (!outcome.ok) {
    console.log('\n✗ Test run failed');
    process.exit(1);
  }

  console.log(
    outcome.reason === 'tolerated-runner-fault'
      ? '\n⚠ All tests passed, but vitest exited non-zero (tolerated)'
      : '\n✓ All tests passed'
  );
  process.exit(0);
}

main().catch((err) => {
  // `main()` was previously called bare. Anything thrown outside a test — a
  // malformed vitest.config.ts reaching loadIsolationTests, say — surfaced as
  // an unhandled rejection rather than as this runner's own failure.
  console.error('\n✗ Test runner crashed:', err?.stack || err);
  process.exit(1);
});
