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

// Sleep helper backed by Atomics.wait so the test thread yields to the OS
// instead of busy-spinning a subprocess per tick (#1083 reviewer feedback).
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);
function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER_PATH = path.join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');

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
function spawnDaemonSentinel(): { pid: number; child: ChildProcess } {
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 60_000);`],
    { stdio: 'ignore', detached: true },
  );
  if (!child.pid) throw new Error('failed to spawn daemon sentinel');
  child.unref();
  return { pid: child.pid, child };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, timeoutMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    sleepMs(50);
  }
  return !isAlive(pid);
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
  fs.mkdirSync(path.join(root, 'node_modules', 'moflo'), { recursive: true });
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
  let sentinel: { pid: number; child: ChildProcess } | null = null;

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

  it('upgrade boundary (section 3): stops daemon before any node:sqlite writer touches the DB', () => {
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

    expect(waitForExit(sentinel.pid, 5_000)).toBe(true);
    expect(fs.existsSync(path.join(root, '.moflo', 'daemon.lock'))).toBe(false);
    // Section 3 emits its own user-visible message — pin it so we know
    // the launcher's upgrade path (not the safety-net path) was the killer.
    expect(result.stdout).toMatch(/stopped daemon for upgrade/);
  });

  it('safety net (section 3a-pre): kills stale daemon when stamp matches but lock disagrees', () => {
    // Stamp matches installed, so section 3 (upgrade detection) skips. The
    // backup version-skew check at section 3a-pre is the only thing left
    // standing between an old daemon and the new node:sqlite writers.
    sentinel = spawnDaemonSentinel();
    seedConsumerLayout(root, {
      daemonPid: sentinel.pid,
      daemonVersion: '4.9.99',
      installedVersion: '4.10.0',
      stampVersion: '4.10.0',
    });

    const result = runLauncher(root);

    expect(waitForExit(sentinel.pid, 5_000)).toBe(true);
    expect(fs.existsSync(path.join(root, '.moflo', 'daemon.lock'))).toBe(false);
    expect(result.stdout).toMatch(/recycled stale daemon/);
    expect(result.stdout).toMatch(/version skew/);
    expect(result.stdout).toMatch(/installed 4\.10\.0/);
    expect(result.stdout).toMatch(/daemon 4\.9\.99/);
  });

  it('safety net handles pre-#1054 daemon (no version field) — recycles via fallback diagnosis', () => {
    sentinel = spawnDaemonSentinel();
    seedConsumerLayout(root, {
      daemonPid: sentinel.pid,
      daemonVersion: undefined,
      installedVersion: '4.10.0',
      stampVersion: '4.10.0',
    });

    const result = runLauncher(root);

    expect(waitForExit(sentinel.pid, 5_000)).toBe(true);
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
