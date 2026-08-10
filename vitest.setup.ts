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

// Drop the ambient CLAUDE_PROJECT_DIR the runner inherited. Claude Code sets it
// to the developer's real project root, and every `spawnSync('node', [LAUNCHER])`
// / `[GATE]` in the suite passes `{ ...process.env }` through — so a call site
// that forgets its own override anchors the child at the REAL repo instead of
// its tmp fixture. `bin/session-start-launcher.mjs` §2 then rewrites
// `.claude/workflow-state.json` with the 4-field session-reset shape, wiping the
// live session's memorySearched/sessionId and every gate flag mid-run. Measured:
// two launcher test files were enough (`tests/bin/launcher-visibility.test.ts`
// spawned the launcher with `{ cwd: root }` and no env at all).
//
// CI never sets the var, so unsetting it here makes local runs match CI rather
// than diverge from it — the divergence is precisely why this only ever bit a
// developer. Nothing in the suite reads it expecting the real repo: every test
// that needs an anchor assigns its own (and restores to `undefined`, i.e. this
// state). With it unset, `findProjectRoot` walks up from the child's cwd, which
// for a tmp fixture stays in the tmp fixture.
//
// Deleted once at module load, NOT in the beforeEach below: test files that set
// the anchor outside a hook (module scope, `beforeAll`, a fixture helper) would
// have it stripped out from under them by a per-test delete.
delete process.env.CLAUDE_PROJECT_DIR;

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

// Skip the CLI's daemon autostart. Tests that shell out to `bin/cli.js` inside
// a throwaway tmp project hit `maybeAutoStartDaemon` with DEFAULT_CONFIG
// (`daemon.auto_start: true`), which spawns a detached + unref'd daemon. The
// test then removes its tmp dir and the daemon survives with a deleted cwd —
// permanently orphaned, since there is no lockfile left to contend for and no
// project root to match it to. These accumulated across suite runs into dozens
// of ~87MB processes that only `doctor --fix` reaped.
//
// Subprocesses inherit this via `{ ...process.env }`, which is what makes it
// reach the spawned CLI. A test that genuinely wants autostart deletes it in
// its own `beforeEach`, same as the two vars below.
process.env.MOFLO_TEST_SKIP_DAEMON_AUTOSTART = '1';

// #1315 — disarm the daemon's deleted-root self-exit inside the test runner.
// `WorkerDaemon.shutdownIfRootVanished()` calls `process.exit(0)` when it sees
// `MOFLO_DAEMON=1`, which is correct for a real daemon whose project was
// deleted. But tests routinely build a WorkerDaemon over a tmp dir and then
// remove it, and a vitest worker that inherited `MOFLO_DAEMON` would exit(0)
// mid-run — reporting every remaining test as passed. Fail loudly, never
// silently green. The self-exit test clears this in its own `beforeEach`.
process.env.MOFLO_TEST_NO_DAEMON_SELF_EXIT = '1';

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
  if (process.env.MOFLO_TEST_SKIP_DAEMON_AUTOSTART !== '1') {
    process.env.MOFLO_TEST_SKIP_DAEMON_AUTOSTART = '1';
  }
  if (process.env.MOFLO_TEST_NO_DAEMON_SELF_EXIT !== '1') {
    process.env.MOFLO_TEST_NO_DAEMON_SELF_EXIT = '1';
  }
});
