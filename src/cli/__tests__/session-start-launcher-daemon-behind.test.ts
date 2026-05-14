/**
 * Launcher §2a recycles a daemon whose lockfile reports a version BEHIND the
 * installed package (#1054 follow-up).
 *
 * Regression for the failure mode where §3a-pre's recycle, positioned after
 * §3's heavy file-sync work, got killed by the 3000ms SessionStart hook
 * timeout before it could run. §2a now runs early — this test asserts the
 * detection + lockfile cleanup happens on a minimal consumer fixture.
 *
 * The fixture uses a dead PID so the launcher's force-kill path returns
 * immediately (via isDaemonPidAlive). That keeps the test cross-platform and
 * exercises the version-compare + unlink path that swallowed the prior bug.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const LAUNCHER = join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');
const RECYCLER_SRC = join(REPO_ROOT, 'bin', 'lib', 'daemon-recycler.mjs');

// PID guaranteed to be dead on every platform. 99_999_999 exceeds Linux's
// default pid_max (4_194_304) and Windows' practical PID range, so
// `process.kill(pid, 0)` and `taskkill /PID 99999999` both fail with
// "no such process" — the recycler's isAlive check short-circuits and the
// kill is a no-op. Must be > 0 so §2a's `daemonPid > 0` guard passes (PID
// 0 takes the "malformed lock" branch in the launcher).
const DEAD_PID = 99_999_999;

function makeConsumer(opts: { daemonVersion: string | null; installedVersion: string }): string {
  const tmp = mkdtempSync(join(tmpdir(), 'moflo-launcher-behind-'));
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  mkdirSync(join(tmp, '.moflo'), { recursive: true });
  mkdirSync(join(tmp, 'node_modules', 'moflo', 'bin'), { recursive: true });

  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ name: 'behind-fixture', version: '0.0.0' }, null, 2),
  );
  writeFileSync(
    join(tmp, 'node_modules', 'moflo', 'package.json'),
    JSON.stringify({ name: 'moflo', version: opts.installedVersion }, null, 2),
  );
  // Pre-stamp moflo-version matching installed so §3's version-bump path
  // does NOT fire — we want to isolate §2a's behavior, not test §3's
  // stopDaemon side effect on the lockfile.
  writeFileSync(join(tmp, '.moflo', 'moflo-version'), opts.installedVersion);
  // Stub cli.js so fireAndForget('daemon start') has something to spawn.
  // Body is a no-op; we never wait on it and it exits immediately.
  writeFileSync(join(tmp, 'node_modules', 'moflo', 'bin', 'cli.js'), 'process.exit(0);\n');
  // §2a resolves bin/lib/daemon-recycler.mjs from node_modules/moflo first.
  // Copy the real recycler in so the fire-and-forget actually runs.
  mkdirSync(join(tmp, 'node_modules', 'moflo', 'bin', 'lib'), { recursive: true });
  copyFileSync(RECYCLER_SRC, join(tmp, 'node_modules', 'moflo', 'bin', 'lib', 'daemon-recycler.mjs'));

  const lockPayload: Record<string, unknown> = { pid: DEAD_PID, startedAt: Date.now(), label: 'moflo-daemon' };
  if (opts.daemonVersion !== null) lockPayload.version = opts.daemonVersion;
  writeFileSync(join(tmp, '.moflo', 'daemon.lock'), JSON.stringify(lockPayload));

  return tmp;
}

// Windows holds the temp dir open briefly while the launcher's detached
// `cli.js` child exits. Retry cleanup so EPERM doesn't fail the test.
function rmConsumerWithRetry(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      // Tiny synchronous backoff — busy-wait, no async machinery in afterEach.
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  // Last attempt — swallow; the OS will clean the temp dir on reboot if needed.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// §2a spawns the recycler detached, so the unlink + restart happens async
// after the launcher exits. Poll for the completion marker the recycler
// writes (`.moflo/daemon-recycle.last.json`) up to ~5s.
async function waitForRecyclerCompletion(root: string, timeoutMs = 5000): Promise<{ status: string; detail?: string } | null> {
  const markerPath = join(root, '.moflo', 'daemon-recycle.last.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      try {
        return JSON.parse(readFileSync(markerPath, 'utf-8'));
      } catch { /* still being written — retry */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function runLauncher(cwd: string) {
  return spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      CI: '1',
      CLAUDE_PROJECT_DIR: cwd,
    },
    input: '',
  });
}

describe('launcher §2a daemon-behind-installed recycle (#1054 follow-up)', () => {
  let consumerRoot: string;

  afterEach(() => {
    if (consumerRoot) rmConsumerWithRetry(consumerRoot);
  });

  it('recycles when daemon version is behind installed (semver compare)', async () => {
    consumerRoot = makeConsumer({ daemonVersion: '4.10.3', installedVersion: '4.10.4' });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    // §2a emits the mutation synchronously before spawning the recycler.
    expect(result.stdout).toMatch(/recycled stale daemon/);
    expect(result.stdout).toMatch(/behind: daemon v4\.10\.3 → installed v4\.10\.4/);

    // Recycler is detached + async — poll for its completion marker.
    const outcome = await waitForRecyclerCompletion(consumerRoot);
    expect(outcome, 'recycler did not write daemon-recycle.last.json within 5s').not.toBeNull();
    expect(outcome!.status).toBe('ok');

    // Lockfile gone after recycler completes.
    expect(existsSync(join(consumerRoot, '.moflo', 'daemon.lock'))).toBe(false);
  });

  it('treats pre-#1054 daemons (no version field) as behind', async () => {
    consumerRoot = makeConsumer({ daemonVersion: null, installedVersion: '4.10.4' });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    expect(result.stdout).toMatch(/recycled stale daemon/);
    expect(result.stdout).toMatch(/<pre-1054 \/ unknown>/);

    const outcome = await waitForRecyclerCompletion(consumerRoot);
    expect(outcome, 'recycler did not write daemon-recycle.last.json within 5s').not.toBeNull();
    expect(outcome!.status).toBe('ok');
    expect(existsSync(join(consumerRoot, '.moflo', 'daemon.lock'))).toBe(false);
  });

  it('leaves an ahead-of-installed daemon alone (downgrade-test scenario)', () => {
    consumerRoot = makeConsumer({ daemonVersion: '4.11.0', installedVersion: '4.10.4' });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    // Lockfile preserved — §2a's semver-BEHIND check is intentionally one-way.
    const lockPath = join(consumerRoot, '.moflo', 'daemon.lock');
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.version).toBe('4.11.0');
    expect(result.stdout).not.toMatch(/recycled stale daemon/);

    // Recycler must NOT have run.
    expect(existsSync(join(consumerRoot, '.moflo', 'daemon-recycle.last.json'))).toBe(false);
  });

  it('leaves a matching-version daemon alone', () => {
    consumerRoot = makeConsumer({ daemonVersion: '4.10.4', installedVersion: '4.10.4' });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    expect(existsSync(join(consumerRoot, '.moflo', 'daemon.lock'))).toBe(true);
    expect(result.stdout).not.toMatch(/recycled stale daemon/);
    expect(existsSync(join(consumerRoot, '.moflo', 'daemon-recycle.last.json'))).toBe(false);
  });
});
