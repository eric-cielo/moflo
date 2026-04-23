import { defineConfig } from 'vitest/config';

/**
 * Tests that pass in isolation but timeout under full-suite load.
 * These are excluded from the parallel run and executed sequentially
 * by scripts/test-runner.mjs in a second pass.
 *
 * To flag a new test: add its path here. The test-runner picks up
 * this list automatically — no other config needed.
 */
export const isolationTests = [
  'tests/bin/process-manager-stress.test.ts',
  'src/modules/memory/src/database-provider.test.ts',
  'src/modules/spells/__tests__/sandbox-tier-integration.test.ts',
  'src/modules/spells/__tests__/spell-sandboxing.test.ts',
  'src/modules/hooks/__tests__/statusline/statusline-collision.test.ts',
  'src/modules/spells/__tests__/integration/permission-system-e2e.test.ts',
  'src/modules/spells/__tests__/integration/spell-engine-e2e.test.ts',
  'tests/system/pluggable-steps-system.test.ts',
  // Timing-based parallelism assertion — Windows maxForks contention pushes
  // the 75ms threshold over on full-suite runs; passes alone consistently.
  'src/modules/spells/__tests__/preflights.test.ts',
  // Command-index registration — dynamic import of the command registry
  // consistently exceeds 5s under full-suite load on Windows (6s cold alone).
  'src/modules/cli/__tests__/spell-command.test.ts',
];

export default defineConfig({
  test: {
    // Use forks to prevent segfaults from native modules (agentdb/sql.js)
    pool: 'forks',
    // Increase heap limit for worker forks — prevents OOM crashes on
    // heavy test suites (analyzer, etc.) that otherwise
    // kill workers and cause vitest to exit 1 even when all tests pass.
    // Vitest 4 moved pool options to top-level (poolOptions is removed).
    execArgv: ['--max-old-space-size=12288'],
    // Limit concurrency to reduce memory pressure on Windows
    maxForks: 2,
    minForks: 1,
    // Only include our own test files — prevents picking up tests from
    // node_modules (agentdb, pnpm, etc.) that cause segfaults.
    include: [
      'src/modules/**/__tests__/**/*.{test,spec}.{ts,mts}',
      'src/modules/**/src/**/*.{test,spec}.{ts,mts}',
      'src/modules/**/tests/**/*.{test,spec}.{ts,mts}',
      'src/__tests__/**/*.{test,spec}.ts',
      'src/plugins/**/__tests__/**/*.{test,spec}.ts',
      'src/plugins/**/tests/**/*.{test,spec}.ts',
      'src/modules/**/examples/**/*.{test,spec}.{ts,mts}',
      'tests/**/*.{test,spec}.{ts,mts,mjs}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.git/**',
      // Appliance tests — require native GGUF/RVFA bindings not installed
      'src/__tests__/appliance/**',
      // RVF tests — require native backends not installed
      'tests/rvf-*.test.ts',
      // Context persistence hook — missing deps
      'tests/context-persistence-hook.test.mjs',
      // Embeddings .mjs tests — collection failures
      'src/modules/embeddings/__tests__/simple.test.mjs',
      'src/modules/embeddings/__tests__/minimal.test.mjs',
      // Guidance tests with 0 tests (collection failures)
      'src/modules/guidance/tests/hooks.test.ts',
      'src/modules/guidance/tests/integration.test.ts',
      // Isolation tests — run sequentially in second pass (see isolationTests above)
      ...isolationTests,
    ],
  },
});
