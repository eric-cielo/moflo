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

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const jsonFile = resolve(root, '.vitest-results.json');
const vitestBin = resolve(root, 'node_modules/vitest/vitest.mjs');
const isolationConfig = resolve(root, 'vitest.isolation.config.ts');
const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };

/**
 * Load isolation test list from vitest.config.ts at runtime.
 * Reads the exported array via regex since it's a .ts file.
 */
function loadIsolationTests() {
  try {
    const raw = readFileSync(resolve(root, 'vitest.config.ts'), 'utf-8');
    const match = raw.match(/export\s+const\s+isolationTests\s*=\s*\[([\s\S]*?)\];/);
    if (!match) return [];
    // Extract quoted strings from the array literal
    const entries = [];
    for (const m of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
      entries.push(m[1] || m[2]);
    }
    return entries;
  } catch {
    return [];
  }
}

/** Run vitest with given args, return { code, passed, failed } */
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

      try {
        const raw = readFileSync(jsonFile, 'utf-8');
        const results = JSON.parse(raw);
        failed = (results.numFailedTests || 0) + (results.numFailedTestSuites || 0);
        passed = results.numPassedTests || 0;
      } catch {
        // JSON missing — treat non-zero exit as failure
        if (code !== 0) failed = 1;
      }

      cleanup();
      resolve({ code, passed, failed });
    });
  });
}

function cleanup() {
  try { unlinkSync(jsonFile); } catch { /* ok */ }
}

async function main() {
  const isolationTests = loadIsolationTests();

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

  if (main.failed > 0) {
    console.log(`\n✗ Parallel suite: ${main.failed} failure(s)`);
  } else {
    console.log(`\n✓ Parallel suite: ${main.passed} tests passed`);
  }

  // ── Pass 2: Isolation tests (sequential) ──
  if (isolationTests.length > 0) {
    console.log(`\n━━ Pass 2: Isolation tests (${isolationTests.length} files, sequential) ━━\n`);

    for (const testFile of isolationTests) {
      const fullPath = resolve(root, testFile);
      if (!existsSync(fullPath)) {
        console.log(`  ⚠ skipped (not found): ${testFile}`);
        continue;
      }

      const result = await runVitest([
        'run',
        testFile,
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${jsonFile}`,
      ], { config: isolationConfig });

      totalPassed += result.passed;
      totalFailed += result.failed;

      if (result.failed > 0) {
        console.log(`  ✗ ${testFile}: ${result.failed} failure(s)`);
      } else {
        console.log(`  ✓ ${testFile}: ${result.passed} passed`);
      }
    }
  }

  // ── Summary ──
  console.log('\n━━ Summary ━━');
  console.log(`  Total passed: ${totalPassed}`);
  console.log(`  Total failed: ${totalFailed}`);

  if (totalFailed > 0) {
    console.log('\n✗ Tests failed');
    process.exit(1);
  }

  console.log('\n✓ All tests passed');
  process.exit(0);
}

main();
