/**
 * System E2E: version-skew kill at the upgrade boundary (#1056 re-verified
 * for #1083 Phase 4).
 *
 * The catastrophic case that gates the node:sqlite default flip is "old
 * daemon (sql.js in RAM) + new bin/ binaries (node:sqlite on disk) writing
 * the same .moflo/moflo.db file with different semantics." The only thing
 * preventing it is #1056's process-kill: when the daemon-lock's `version`
 * differs from the installed `node_modules/moflo/package.json` version, the
 * launcher SIGTERMs the daemon and unlinks the lock BEFORE any node:sqlite
 * writer can touch the DB.
 *
 * The existing `tests/bin/launcher-1056-version-skew.test.ts` is a static
 * grep test against launcher source. This file is the runtime
 * complement — spawns a real sentinel "daemon" process at version X, writes
 * a node_modules/moflo/package.json at version Y, runs the launcher as a
 * subprocess, and asserts:
 *
 *   1. The sentinel process gets SIGTERM'd
 *   2. The daemon-lock file is removed
 *   3. Stdout includes the user-visible mutation message naming both versions
 *
 * Three timing edge cases — fast daemon, slow daemon, pre-#1054 daemon
 * (no version field) — give us the "across daemon-restart edge cases"
 * coverage epic #1078 Phase 4 asks for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER_PATH = path.join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');
const RECYCLER_PATH = path.join(REPO_ROOT, 'bin', 'lib', 'daemon-recycler.mjs');

function makeRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'moflo-1083-vskew-'));
}

/**
 * Spawn a long-running detached "daemon" sentinel. Returns the live PID.
 * The sentinel does nothing except stay alive long enough for the launcher
 * to discover the stale lock and SIGTERM it. `detached: true` + `unref()`
 * puts it in its own process group so a test-runner crash doesn't orphan
 * it into the parent group.
 */
function spawnDaemonSentinel(): { pid: number; child: ChildProcess; exited: Promise<void> } {
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 60_000);`],
    { stdio: 'ignore', detached: true },
  );
  if (!child.pid) throw new Error('failed to spawn daemon sentinel');
  // Resolve on the child's actual 'exit' event. `process.kill(pid, 0)` is
  // unreliable on Linux: after SIGTERM the sentinel becomes a zombie because
  // its parent (this test process) hasn't reaped it, and `kill -0 zombie`
  // still reports "alive". Windows has no zombie semantics, which is why the
  // earlier kill-0 poll passed locally but failed in Linux CI (#1083).
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.unref();
  return { pid: child.pid, child, exited };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(
  sentinel: { exited: Promise<void> },
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const result = await Promise.race([sentinel.exited.then(() => true as const), timeout]);
    return result === true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The §2a recycler is detached, so the lockfile unlink + fresh daemon spawn
 * happen after the launcher exits. Poll for the recycler's completion marker
 * (`.moflo/daemon-recycle.last.json`, written by bin/lib/daemon-recycler.mjs)
 * up to `timeoutMs` so the test doesn't race the unlink.
 */
async function waitForRecyclerCompletion(
  root: string,
  timeoutMs: number,
): Promise<{ status: string } | null> {
  const markerPath = path.join(root, '.moflo', 'daemon-recycle.last.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerPath)) {
      try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      } catch { /* mid-write — retry */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

interface SeedOptions {
  daemonPid: number;
  daemonVersion: string | undefined;
  installedVersion: string;
  /** When set, writes `.moflo/moflo-version` so section 3 (upgrade detection) skips. */
  stampVersion?: string;
}

function seedConsumerLayout(root: string, opts: SeedOptions): void {
  fs.mkdirSync(path.join(root, '.moflo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'moflo', 'bin', 'lib'), { recursive: true });
  const lockPayload: Record<string, unknown> = { pid: opts.daemonPid, startedAt: Date.now() };
  if (opts.daemonVersion !== undefined) lockPayload.version = opts.daemonVersion;
  fs.writeFileSync(
    path.join(root, '.moflo', 'daemon.lock'),
    JSON.stringify(lockPayload),
  );
  fs.writeFileSync(
    path.join(root, 'node_modules', 'moflo', 'package.json'),
    JSON.stringify({ name: 'moflo', version: opts.installedVersion }),
  );
  // §2a fire-and-forgets the detached recycler — must be present in the
  // fixture's node_modules/moflo/bin/lib/ for resolveDaemonRecyclerPath to
  // find it. A stub `cli.js` is also required so the recycler's
  // `daemon start --quiet` spawn has a target.
  fs.copyFileSync(RECYCLER_PATH, path.join(root, 'node_modules', 'moflo', 'bin', 'lib', 'daemon-recycler.mjs'));
  fs.writeFileSync(path.join(root, 'node_modules', 'moflo', 'bin', 'cli.js'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-consumer-1083' }),
  );
  if (opts.stampVersion !== undefined) {
    fs.writeFileSync(path.join(root, '.moflo', 'moflo-version'), opts.stampVersion);
  }
}

interface LauncherResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runLauncher(root: string): LauncherResult {
  const result = spawnSync(process.execPath, [LAUNCHER_PATH], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('launcher version-skew kill at upgrade boundary (#1056 / #1083 Phase 4)', () => {
  let root: string;
  let sentinel: { pid: number; child: ChildProcess; exited: Promise<void> } | null = null;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    if (sentinel && isAlive(sentinel.pid)) {
      try { process.kill(sentinel.pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    sentinel = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('upgrade boundary (section 3): stops daemon before any node:sqlite writer touches the DB', async () => {
    // First-session-post-upgrade case: no version stamp on disk yet, so
    // the launcher's upgrade-detection block fires. Even before #1056's
    // explicit version-skew check runs, the upgrade block must SIGTERM the
    // pre-upgrade daemon — otherwise an old sql.js daemon could keep writing
    // while new node:sqlite binaries also write, which is the catastrophic
    // case epic #1078 Phase 4 gates on.
    sentinel = spawnDaemonSentinel();
    seedConsumerLayout(root, {
      daemonPid: sentinel.pid,
      daemonVersion: '4.9.99',
      installedVersion: '4.10.0',
      // stampVersion omitted — fresh post-install layout
    });

    const result = runLauncher(root);

    expect(await waitForExit(sentinel, 5_000)).toBe(true);
    expect(fs.existsSync(path.join(root, '.moflo', 'daemon.lock'))).toBe(false);
    // Section 3 emits its own user-visible message — pin it so we know
    // the launcher's upgrade path (not the safety-net path) was the killer.
    expect(result.stdout).toMatch(/stopped daemon for upgrade/);
  });

  it('safety net (§2a, promoted from §3a-pre): recycles stale daemon when stamp matches but lock disagrees', async () => {
    // Stamp matches installed, so §3 (upgrade detection) skips. §2a is the
    // backup version-BEHIND check — the only thing left standing between an
    // old daemon and the new node:sqlite writers. The check used to live at
    // §3a-pre (downstream of §3's heavy work) and got killed by the 3000ms
    // SessionStart hook timeout on the very sessions that needed it.
    //
    // §2a now fire-and-forgets bin/lib/daemon-recycler.mjs detached. The
    // launcher returns inside its budget; the recycler does the kill+wait+
    // restart in a separate process. From the test's perspective, the
    // sentinel still gets killed and the lockfile still gets removed —
    // just by the recycler, not the launcher itself.
    sentinel = spawnDaemonSentinel();
    seedConsumerLayout(root, {
      daemonPid: sentinel.pid,
      daemonVersion: '4.9.99',
      installedVersion: '4.10.0',
      stampVersion: '4.10.0',
    });

    const result = runLauncher(root);

    expect(await waitForExit(sentinel, 5_000)).toBe(true);
    // Recycler is detached — wait for its completion marker before asserting
    // on the lockfile unlink it owns.
    const outcome = await waitForRecyclerCompletion(root, 5_000);
    expect(outcome?.status, `recycler did not complete cleanly. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe('ok');
    expect(fs.existsSync(path.join(root, '.moflo', 'daemon.lock'))).toBe(false);
    expect(result.stdout).toMatch(/recycled stale daemon/);
    // New §2a message format names both versions inline.
    expect(result.stdout).toMatch(/behind:\s*daemon\s+v4\.9\.99/);
    expect(result.stdout).toMatch(/installed\s+v4\.10\.0/);
  });

  it('safety net handles pre-#1054 daemon (no version field) — recycles via fallback diagnosis', async () => {
    sentinel = spawnDaemonSentinel();
    seedConsumerLayout(root, {
      daemonPid: sentinel.pid,
      daemonVersion: undefined,
      installedVersion: '4.10.0',
      stampVersion: '4.10.0',
    });

    const result = runLauncher(root);

    expect(await waitForExit(sentinel, 5_000)).toBe(true);
    const outcome = await waitForRecyclerCompletion(root, 5_000);
    expect(outcome?.status, `recycler did not complete cleanly. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe('ok');
    expect(fs.existsSync(path.join(root, '.moflo', 'daemon.lock'))).toBe(false);
    expect(result.stdout).toMatch(/recycled stale daemon/);
    // The fallback label is the load-bearing one — pin it so doctor's
    // version-skew check stays correlated with the launcher.
    expect(result.stdout).toMatch(/<pre-1054 \/ unknown>/);
  });

  it('no false positives: matched versions leave the daemon alone', () => {
    sentinel = spawnDaemonSentinel();
    seedConsumerLayout(root, {
      daemonPid: sentinel.pid,
      daemonVersion: '4.10.0',
      installedVersion: '4.10.0',
      stampVersion: '4.10.0',
    });

    const result = runLauncher(root);

    expect(isAlive(sentinel.pid)).toBe(true);
    expect(fs.existsSync(path.join(root, '.moflo', 'daemon.lock'))).toBe(true);
    expect(result.stdout).not.toMatch(/recycled stale daemon/);
    expect(result.stdout).not.toMatch(/stopped daemon for upgrade/);
  });
});
