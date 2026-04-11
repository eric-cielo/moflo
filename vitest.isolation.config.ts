import { defineConfig } from 'vitest/config';

/**
 * Minimal vitest config for isolation tests.
 * No exclude list — the test-runner passes specific files to run.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--max-old-space-size=12288'],
    maxForks: 1,
    minForks: 1,
  },
});
