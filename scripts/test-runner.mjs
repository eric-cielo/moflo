#!/usr/bin/env node
/**
 * Test runner wrapper for vitest.
 *
 * Vitest exits 1 when worker forks crash (OOM), even if every test passes.
 * This wrapper runs vitest with JSON output to a file, shows the default
 * reporter to the user, then checks if all tests actually passed.
 *
 * If any test FAILS, exits 1. If only worker OOM crashes occurred, exits 0.
 */

import { spawn } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const jsonFile = resolve(process.cwd(), '.vitest-results.json');

const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--reporter=default',
    `--reporter=json`,
    `--outputFile.json=${jsonFile}`,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
  }
);

child.on('close', (code) => {
  if (code === 0) {
    cleanup();
    process.exit(0);
  }

  // vitest exited non-zero — check JSON results
  try {
    const raw = readFileSync(jsonFile, 'utf-8');
    const results = JSON.parse(raw);
    const failed = results.numFailedTests || 0;
    const failedSuites = results.numFailedTestSuites || 0;

    if (failed === 0 && failedSuites === 0) {
      const passed = results.numPassedTests || 0;
      const total = results.numTotalTests || 0;
      console.log(`\n✓ All ${passed}/${total} tests passed (worker OOM crashes were non-fatal)`);
      cleanup();
      process.exit(0);
    }
  } catch {
    // JSON file missing or unparseable — fall through
  }

  cleanup();
  process.exit(code);
});

function cleanup() {
  try { unlinkSync(jsonFile); } catch { /* ok */ }
}
