import { defineConfig } from 'vitest/config';

/**
 * Bench config: runs `*.perf.ts` files outside the `npm test` gate.
 * Wired via `npm run bench`. See #956 — perf-threshold suites belong in
 * a dedicated phase, not racing with the unit-test fork pool for CPU.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    execArgv: ['--max-old-space-size=12288'],
    maxForks: 1,
    minForks: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/cli/**/*.perf.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.git/**',
      '.claude/worktrees/**',
    ],
  },
});
