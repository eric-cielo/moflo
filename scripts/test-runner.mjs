#!/usr/bin/env node
/**
 * Test runner wrapper for vitest.
 *
 * 1. Runs the main parallel suite (excludes isolation tests).
 * 2. Runs each isolation test sequentially — these pass alone but
 *    timeout under full-suite resource contention.
 * 3. Exits 0 only if both passes succeed.
 *
 * Vitest exits 1 when worker forks crash (OOM), even if every test
 * passes. The JSON output check distinguishes real failures from that.
 */

import { spawn } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadIsolationTests } from './load-isolation-tests.mjs';
import { extractFailures, printFailures } from './test-runner-failures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const jsonFile = resolve(root, '.vitest-results.json');
const vitestBin = resolve(root, 'node_modules/vitest/vitest.mjs');
const isolationConfig = resolve(root, 'vitest.isolation.config.ts');
const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };

/** Run vitest with given args, return { code, passed, failed, failures } */
function runVitest(args, { config } = {}) {
  const finalArgs = [vitestBin, ...args];
  if (config) finalArgs.push('--config', config);

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

      try {
        const raw = readFileSync(jsonFile, 'utf-8');
        const results = JSON.parse(raw);
        failed = (results.numFailedTests || 0) + (results.numFailedTestSuites || 0);
        passed = results.numPassedTests || 0;
        failures = extractFailures(results);
      } catch {
        // JSON missing — treat non-zero exit as failure
        if (code !== 0) failed = 1;
      }

      cleanup();
      resolve({ code, passed, failed, failures });
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
  const main = await runVitest([
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${jsonFile}`,
  ]);

  let totalPassed = main.passed;
  let totalFailed = main.failed;
  const allFailures = [...main.failures];

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
  const presentIsolationTests = isolationTests.filter((t) => {
    if (existsSync(resolve(root, t))) return true;
    console.log(`  ⚠ skipped (not found): ${t}`);
    return false;
  });

  if (presentIsolationTests.length > 0) {
    console.log(`\n━━ Pass 2: Isolation tests (${presentIsolationTests.length} files, single batch) ━━\n`);

    const result = await runVitest([
      'run',
      ...presentIsolationTests,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${jsonFile}`,
    ], { config: isolationConfig });

    totalPassed += result.passed;
    totalFailed += result.failed;
    allFailures.push(...result.failures);

    if (result.failed > 0) {
      console.log(`\n✗ Isolation batch: ${result.failed} failure(s)`);
      printFailures('isolation batch', result.failures);
    } else {
      console.log(`\n✓ Isolation batch: ${result.passed} tests passed`);
    }
  }

  // ── Summary ──
  console.log('\n━━ Summary ━━');
  console.log(`  Total passed: ${totalPassed}`);
  console.log(`  Total failed: ${totalFailed}`);

  if (totalFailed > 0) {
    printFailures('full run', allFailures);
    console.log('\n✗ Tests failed');
    process.exit(1);
  }

  console.log('\n✓ All tests passed');
  process.exit(0);
}

main();
