import { defineConfig } from 'vitest/config';

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
      // Security module tests that need native crypto (bcrypt, etc.)
      'src/modules/security/__tests__/password-hasher.test.ts',
      'src/modules/security/__tests__/safe-executor.test.ts',
      'src/modules/security/__tests__/credential-generator.test.ts',
      'src/modules/security/__tests__/path-validator.test.ts',
      'src/modules/security/__tests__/input-validator.test.ts',
      'src/modules/security/__tests__/token-generator.test.ts',
      'src/modules/security/__tests__/unit/safe-executor.test.ts',
      'src/modules/security/__tests__/unit/path-validator.test.ts',
      'src/modules/security/__tests__/unit/token-generator.test.ts',
      'src/modules/security/__tests__/unit/credential-generator.test.ts',
      'src/modules/security/__tests__/unit/password-hasher.test.ts',
      // Embeddings .mjs tests — collection failures
      'src/modules/embeddings/__tests__/simple.test.mjs',
      'src/modules/embeddings/__tests__/minimal.test.mjs',
      // Guidance tests with 0 tests (collection failures)
      'src/modules/guidance/tests/hooks.test.ts',
      'src/modules/guidance/tests/integration.test.ts',
    ],
  },
});
