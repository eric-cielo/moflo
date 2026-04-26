import { defineConfig } from 'vitest/config';

/**
 * Minimal vitest config for isolation tests.
 * No exclude list — the test-runner passes specific files to run.
 *
 * testTimeout is bumped here because the isolation batch runs ~40 heavy
 * test files sequentially in one fork (maxForks:1). Tests that finish in
 * 1–2 s alone can still take 10–15 s under cumulative fork pressure
 * (transform cache, dynamic imports, GC). The default 5 s is not enough.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--max-old-space-size=12288'],
    maxForks: 1,
    minForks: 1,
    testTimeout: 30_000,
  },
});
