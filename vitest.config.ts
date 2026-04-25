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
  // CLI/spell dynamic-import heavy tests — all pass cleanly alone but
  // intermittently exceed their per-test timeouts under full-suite load
  // (maxForks=2 + Windows fork contention). Confirmed green in isolation.
  'src/modules/cli/__tests__/doctor-checks-deep.test.ts',
  'src/modules/cli/__tests__/p1-commands.test.ts',
  'src/modules/cli/__tests__/services/worker-daemon-resource-thresholds.test.ts',
  'src/modules/cli/__tests__/spell-tools-engine.test.ts',
  'src/modules/spells/__tests__/connector-lifecycle.test.ts',
  // prerequisites.test.ts split into 4 files (#522) — all share the same
  // dynamic-import load profile, so all four stay on the isolation list.
  'src/modules/spells/__tests__/prerequisites-registry.test.ts',
  'src/modules/spells/__tests__/prerequisites-spec.test.ts',
  'src/modules/spells/__tests__/prerequisites-resolve.test.ts',
  'src/modules/spells/__tests__/prerequisites-integration.test.ts',
  'tests/bin/gate-helpers.test.ts',
  // Spawn/kill timing sensitive — `getActive returns only alive processes`
  // intermittently observes the child before it's reaped on Windows maxForks=2.
  // Passes in isolation; add here rather than retry-in-place.
  'tests/bin/process-manager.test.ts',
  // First-run downloads the 25 MB ONNX model from GCS and runs real ORT
  // inference — competes for CPU/network with parallel benchmarks under
  // maxForks=2 and pushes neighboring tests over their timeouts. Cached
  // runs are <2 s but the cache-cold path is the one CI exercises.
  'src/modules/cli/__tests__/embeddings/fastembed-inline-integration.test.ts',
  // Issue #617 — full-suite Windows fork contention triage. Across 4
  // back-to-back `npm test` runs the failure set varied 31/41/42/49 with
  // wildly different members; every file below was verified to pass in
  // isolation (and the three that needed individual re-verification —
  // doctor-sandbox-tier, pause-resume, runner-bridge — pass cleanly when
  // run alone, but exceed 5 s timeouts when batched even sequentially).
  'src/modules/cli/__tests__/cli.test.ts',
  'src/modules/cli/__tests__/doctor-sandbox-tier.test.ts',
  'src/modules/cli/__tests__/mcp-tools-deep.test.ts',
  'src/modules/cli/__tests__/services/moflo-require.test.ts',
  'src/modules/cli/__tests__/guidance/persistence.test.ts',
  'src/modules/hooks/__tests__/workers.test.ts',
  'src/modules/cli/src/shared/hooks/verify-exports.test.ts',
  'src/modules/spells/__tests__/built-in-commands.test.ts',
  'src/modules/spells/__tests__/moflo-levels.test.ts',
  'src/modules/spells/__tests__/parallel-integration.test.ts',
  'src/modules/spells/__tests__/pause-resume.test.ts',
  'src/modules/spells/__tests__/preflight-severity.test.ts',
  'src/modules/spells/__tests__/runner-bridge.test.ts',
  'src/modules/spells/__tests__/runner.test.ts',
  'src/modules/spells/__tests__/tool-registry.test.ts',
  'tests/bin/bin-scripts.test.ts',
  'tests/guards/hash-fallback-guard.test.ts',
  'tests/hive-mind-messagebus.test.ts',
  'tests/issue-fixes.test.ts',
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
      // Context persistence hook — missing deps
      'tests/context-persistence-hook.test.mjs',
      // Embeddings .mjs tests — collection failures
      'src/modules/cli/__tests__/embeddings/simple.test.mjs',
      'src/modules/cli/__tests__/embeddings/minimal.test.mjs',
      // Guidance tests with 0 tests (collection failures)
      'src/modules/cli/__tests__/guidance/hooks.test.ts',
      'src/modules/cli/__tests__/guidance/integration.test.ts',
      // Isolation tests — run sequentially in second pass (see isolationTests above)
      ...isolationTests,
    ],
  },
});
