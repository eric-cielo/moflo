import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use forks to prevent segfaults from native modules (agentdb/sql.js)
    pool: 'forks',
    // Only include our own test files — prevents picking up tests from
    // node_modules (agentdb, pnpm, etc.) that cause segfaults.
    include: [
      'src/@claude-flow/**/__tests__/**/*.{test,spec}.{ts,mts}',
      'src/@claude-flow/**/src/**/*.{test,spec}.{ts,mts}',
      'src/@claude-flow/**/tests/**/*.{test,spec}.{ts,mts}',
      'src/mcp/__tests__/**/*.{test,spec}.ts',
      'src/__tests__/**/*.{test,spec}.ts',
      'src/plugins/**/__tests__/**/*.{test,spec}.ts',
      'src/plugins/**/tests/**/*.{test,spec}.ts',
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
      'src/@claude-flow/security/__tests__/password-hasher.test.ts',
      'src/@claude-flow/security/__tests__/safe-executor.test.ts',
      'src/@claude-flow/security/__tests__/credential-generator.test.ts',
      'src/@claude-flow/security/__tests__/path-validator.test.ts',
      'src/@claude-flow/security/__tests__/input-validator.test.ts',
      'src/@claude-flow/security/__tests__/token-generator.test.ts',
      'src/@claude-flow/security/__tests__/unit/safe-executor.test.ts',
      'src/@claude-flow/security/__tests__/unit/path-validator.test.ts',
      'src/@claude-flow/security/__tests__/unit/token-generator.test.ts',
      'src/@claude-flow/security/__tests__/unit/credential-generator.test.ts',
      'src/@claude-flow/security/__tests__/unit/password-hasher.test.ts',
      // Embeddings .mjs tests — collection failures
      'src/@claude-flow/embeddings/__tests__/simple.test.mjs',
      'src/@claude-flow/embeddings/__tests__/minimal.test.mjs',
      // Guidance tests with 0 tests (collection failures)
      'src/@claude-flow/guidance/tests/hooks.test.ts',
      'src/@claude-flow/guidance/tests/integration.test.ts',
    ],
  },
});
