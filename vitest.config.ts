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
  // Spawns real `git` subprocesses to build temp repos per probe (#1093 already
  // moved the classifier probes in-process; setup still shells out). Passes
  // alone and in lighter runs, but the extra fork load from #1198's new bin
  // tests tips its git setup past timeout under maxForks=2 Windows contention.
  'tests/bin/simplify-classify.test.ts',
  'src/cli/memory/database-provider.test.ts',
  'src/cli/__tests__/spells/sandbox-tier-integration.test.ts',
  'src/cli/__tests__/spells/spell-sandboxing.test.ts',
  'src/cli/__tests__/spells/integration/permission-system-e2e.test.ts',
  'src/cli/__tests__/spells/integration/spell-engine-e2e.test.ts',
  'tests/system/pluggable-steps-system.test.ts',
  // Timing-based parallelism assertion — Windows maxForks contention pushes
  // the 75ms threshold over on full-suite runs; passes alone consistently.
  'src/cli/__tests__/spells/preflights.test.ts',
  // Command-index registration — dynamic import of the command registry
  // consistently exceeds 5s under full-suite load on Windows (6s cold alone).
  'src/cli/__tests__/spell-command.test.ts',
  // CLI/spell dynamic-import heavy tests — all pass cleanly alone but
  // intermittently exceed their per-test timeouts under full-suite load
  // (maxForks=2 + Windows fork contention). Confirmed green in isolation.
  'src/cli/__tests__/doctor-checks-deep.test.ts',
  // Issue #818 — doctor-checks-swarm dynamically imports dist mcp-tools and
  // exercises the real UnifiedSwarmCoordinator end-to-end. Same dynamic-import
  // load profile as doctor-checks-deep above; same isolation rationale.
  'src/cli/__tests__/doctor-checks-swarm.test.ts',
  'src/cli/__tests__/services/worker-daemon-resource-thresholds.test.ts',
  // Spawns real fake-daemon processes for PID detection (~5s alone); the
  // process-spawn + introspection timing intermittently exceeds its timeout
  // under full-suite fork contention. Passes cleanly in isolation (8/8).
  'src/cli/__tests__/services/daemon-lock-orphan.test.ts',
  'src/cli/__tests__/spells/connector-lifecycle.test.ts',
  // prerequisites.test.ts split into 4 files (#522) — all share the same
  // dynamic-import load profile, so all four stay on the isolation list.
  'src/cli/__tests__/spells/prerequisites-registry.test.ts',
  'src/cli/__tests__/spells/prerequisites-spec.test.ts',
  'src/cli/__tests__/spells/prerequisites-resolve.test.ts',
  'src/cli/__tests__/spells/prerequisites-integration.test.ts',
  'tests/bin/gate-helpers.test.ts',
  // First-run downloads the 25 MB ONNX model from GCS and runs real ORT
  // inference — competes for CPU/network with parallel benchmarks under
  // maxForks=2 and pushes neighboring tests over their timeouts. Cached
  // runs are <2 s but the cache-cold path is the one CI exercises.
  'src/cli/__tests__/embeddings/fastembed-inline-integration.test.ts',
  // Issue #617 — full-suite Windows fork contention triage. Across 4
  // back-to-back `npm test` runs the failure set varied 31/41/42/49 with
  // wildly different members; every file below was verified to pass in
  // isolation (and the three that needed individual re-verification —
  // doctor-sandbox-tier, pause-resume, runner-bridge — pass cleanly when
  // run alone, but exceed 5 s timeouts when batched even sequentially).
  'src/cli/__tests__/cli.test.ts',
  'src/cli/__tests__/doctor-sandbox-tier.test.ts',
  'src/cli/__tests__/mcp-tools-deep.test.ts',
  'src/cli/__tests__/services/moflo-require.test.ts',
  'src/cli/__tests__/guidance/persistence.test.ts',
  'src/cli/shared/hooks/verify-exports.test.ts',
  'src/cli/__tests__/spells/moflo-levels.test.ts',
  'src/cli/__tests__/spells/parallel-integration.test.ts',
  'src/cli/__tests__/spells/pause-resume.test.ts',
  'src/cli/__tests__/spells/preflight-severity.test.ts',
  'src/cli/__tests__/spells/runner-bridge.test.ts',
  'src/cli/__tests__/spells/runner.test.ts',
  'src/cli/__tests__/spells/tool-registry.test.ts',
  'tests/bin/bin-scripts.test.ts',
  'tests/guards/hash-fallback-guard.test.ts',
  'tests/hive-mind-messagebus.test.ts',
  'tests/issue-fixes.test.ts',
  // process.chdir + bridge singleton reset per test — racy under parallel
  // forks because cwd is process-global and the registry singleton is
  // module-shared.
  'src/cli/__tests__/bridge-entries.test.ts',
  // process.chdir per-test, same singleton/cwd contention as bridge-entries.
  'src/cli/__tests__/bridge-vector-stats-anti-clobber.test.ts',
  // #896 — process.chdir per-test to redirect findProjectRoot at the doctor
  // check; cwd-global means parallel forks would step on each other.
  'src/cli/__tests__/doctor-hook-drift-off-mode.test.ts',
  // performance/timing assertions (initialize<500ms, shutdown<100ms, access
  // overhead<threshold) bust under Windows parallel-fork contention; whole
  // file passes <200ms in isolation.
  'src/cli/memory/controller-registry.test.ts',
  // Both files load real fastembed via runEmbeddingsMigrationIfNeeded; the
  // ONNX model is lazy-loaded on first use and re-loading per fork under
  // maxForks=2 contention pushes the runUpgrade tests past their timeout.
  // Pass cleanly in isolation in <2 s.
  'src/cli/__tests__/services/embeddings-migration.test.ts',
  'src/cli/__tests__/services/embeddings-migration-callbacks.test.ts',
  // 5 s per-test timeout vs ~6 s on Windows full-suite fork contention; the
  // file shells out to ../helpers/statusline.cjs and waits on its stdout. All
  // ten tests pass alone in <4 s total.
  'src/cli/__tests__/statusline-upgrade-notice.test.ts',
  // Same spawn(statusline.cjs) profile as statusline-upgrade-notice; the new
  // #1059 reconciliation tests check JSON output for `reconciled` + the
  // compact render for the `?` fallback.
  'src/cli/__tests__/statusline-vector-reconciliation.test.ts',
  // Issue #844 — same dynamic-import + real-coordinator load profile as
  // doctor-checks-deep / doctor-checks-swarm (already on this list). Spawns
  // swarm + hive-mind workers and runs three memory round-trips against the
  // real subsystem; reliably fits in 10 s alone, can drift past full-suite
  // per-test ceilings under fork contention.
  'src/cli/__tests__/doctor-checks-memory-access.test.ts',
];

export default defineConfig({
  test: {
    // #981 — disable daemon-routing preamble during tests (see vitest.setup.ts).
    setupFiles: ['./vitest.setup.ts'],
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
      'src/cli/__tests__/**/*.{test,spec}.{ts,mts}',
      'src/cli/**/*.{test,spec}.{ts,mts}',
      'src/__tests__/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.{ts,mts,mjs}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.git/**',
      // Parallel-agent git worktrees check out a full source tree under
      // `.claude/worktrees/<id>/`. Without this exclude, vitest globs the
      // duplicate test files and they fail dist-resolution because each
      // worktree has its own out-of-tree compiled output.
      '.claude/worktrees/**',
      // Guidance tests with 0 tests (collection failures)
      'src/cli/__tests__/guidance/integration.test.ts',
      // Isolation tests — run sequentially in second pass (see isolationTests above)
      ...isolationTests,
    ],
  },
});
