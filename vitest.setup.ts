/**
 * Global vitest setup.
 *
 * #981 — disable the storeEntry/deleteEntry daemon-routing preamble during
 * tests by default. Tests run in vitest workers with no real daemon, but the
 * isolation pass shares a single worker across many test files, so the
 * routing preamble's module-level health cache (5s TTL) and per-call HTTP
 * probe (100ms timeout) introduce timing variance that surfaces as flakes
 * (e.g. doctor-checks-memory-access cleanup race on Linux CI).
 *
 * Tests that explicitly want to exercise the routing path —
 * `tests/system/multi-process-write-visibility.test.ts` and the
 * store-entry-routing / daemon-write-client unit tests — set/unset this
 * env var inside their own `beforeEach` blocks. Setting it here as the
 * default keeps the rest of the suite unaffected by routing.
 */

import { beforeEach } from 'vitest';

// Install the node:sqlite ExperimentalWarning filter BEFORE any test file
// imports anything that touches `node:sqlite`. The warning fires once per
// worker process on first load and pollutes the noise budget for tests
// that snapshot or assert on stderr. (#1098)
import './src/cli/memory/suppress-sqlite-warning.js';

// #1154 — every vitest fork runs many test files sequentially with shared
// process state. Several test files `process.chdir(tmpDir)` to redirect
// `findProjectRoot()` and restore in afterEach, but a throw before the
// restore — or a module that caches `process.cwd()` at import time — leaves
// the next test file in the same fork running at a stale or deleted path.
// Victims that read `process.cwd()` (dashboard-claude-stats-route, the
// simplify-classify default-branch detector under git contention) then flake
// 0–3× per `npm test` run on Windows.
//
// INITIAL_CWD is captured once at module load (each fork loads this setup
// fresh). The beforeEach below restores it for every test as belt-and-
// suspenders — tests that intentionally chdir do so in their own
// beforeEach, which runs *after* this one.
const INITIAL_CWD = process.cwd();

// Set once at module load (every test file imports this setup).
process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

// #1086 — skip the Windows tasklist/powershell daemon-introspection chain
// in tests. The two execSync calls (3s + 5s timeouts) inside isDaemonProcess
// can starve under parallel-suite contention and push daemon-lock-reading
// tests past vitest's 5s per-test budget. Tests that write `process.pid`
// into a synthetic `daemon.lock` rely on this trust to verify the
// version-skew / payload-read logic without depending on OS introspection
// surviving load. Production never sets this env var.
process.env.MOFLO_TEST_TRUST_DAEMON_PID = '1';

// #1150 — skip the same-project orphan scan in `acquireDaemonLock` for the
// same reasons as TRUST_DAEMON_PID above: the PowerShell/CIM enumeration on
// Windows is expensive and tests using synthetic tempDir-rooted "daemons"
// don't need it. Tests for the orphan scan itself clear this env-var in
// their own `beforeEach` blocks and re-set it after.
process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN = '1';

// Re-set in `beforeEach` so a test that intentionally cleared it for a
// routing scenario doesn't bleed into the next test.
beforeEach(() => {
  // #1154 — restore cwd first so subsequent env/init code runs at a known path.
  if (process.cwd() !== INITIAL_CWD) {
    try { process.chdir(INITIAL_CWD); } catch { /* dir may have been removed */ }
  }
  if (process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1') {
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
  }
  if (process.env.MOFLO_TEST_TRUST_DAEMON_PID !== '1') {
    process.env.MOFLO_TEST_TRUST_DAEMON_PID = '1';
  }
  if (process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN !== '1') {
    process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN = '1';
  }
});
