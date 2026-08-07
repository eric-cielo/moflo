/**
 * `Daemon Orphan` healer check + auto-fix test (#1150).
 *
 * Spawns a real same-project fake daemon process so the platform
 * introspection chain (Get-CimInstance on Windows, `/proc` on Linux,
 * `ps` on macOS) exercises end-to-end. Confirms the check transitions
 * pass → fail → pass across the spawn-and-fix cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { autoFixCheck } from '../../commands/doctor-fixes.js';
import { checkDaemonOrphan } from '../../commands/doctor-checks-config.js';
import { findProjectDaemonPids, lockPath, reapSameProjectOrphans } from '../../services/daemon-lock.js';
import { findProjectRoot } from '../../services/project-root.js';

const FAKE_DAEMON_SCRIPT = `
process.stdin.resume();
setInterval(() => {}, 60_000);
`;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForDead(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

describe('Daemon Orphan healer (#1150)', () => {
  let tempDir: string;
  let priorCwd: string;
  let priorSkip: string | undefined;
  let priorProjectDir: string | undefined;
  let children: ChildProcess[] = [];

  beforeEach(() => {
    priorSkip = process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;
    delete process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;

    priorCwd = process.cwd();
    // realpathSync: macOS hands out `/var/folders/...` paths that resolve to
    // `/private/var/folders/...`, and `projectCliCandidates` realpaths the root
    // prefix before matching a daemon cmdline (#1145). Without this the
    // candidate paths and the spawned daemon's cmdline never match on macOS.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'orphan-fix-')));
    mkdirSync(join(tempDir, '.moflo'), { recursive: true });
    mkdirSync(join(tempDir, 'bin'), { recursive: true });
    writeFileSync(join(tempDir, 'bin', 'cli.js'), FAKE_DAEMON_SCRIPT);
    process.chdir(tempDir);

    // #1431 — the fix handlers now resolve via `findProjectRoot()`, which
    // honors `CLAUDE_PROJECT_DIR` ahead of cwd. Under vitest that variable
    // points at the real moflo checkout, so without this anchor these tests
    // would enumerate — and reap — the developer's own running daemons.
    priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tempDir;
  });

  afterEach(async () => {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* ok */ }
    }
    await new Promise(r => setTimeout(r, 100));
    children = [];
    process.chdir(priorCwd);
    rmSync(tempDir, { recursive: true, force: true });
    if (priorSkip !== undefined) process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN = priorSkip;
    if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
  });

  function spawnFakeDaemon(): Promise<number> {
    return new Promise((resolve, reject) => {
      const cliPath = join(tempDir, 'bin', 'cli.js');
      // See daemon-lock-orphan.test.ts for why detached+unref on POSIX:
      // init reaps the zombie so the kill-window poll converges even when
      // the test parent's event loop is blocked.
      const child = spawn(
        process.execPath,
        [cliPath, 'daemon', 'start', '--moflo-fake-daemon-tag'],
        {
          cwd: tempDir,
          detached: process.platform !== 'win32',
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.on('error', reject);
      child.on('spawn', () => {
        if (child.pid) {
          children.push(child);
          if (process.platform !== 'win32') child.unref();
          setTimeout(() => resolve(child.pid!), 200);
        } else {
          reject(new Error('no pid'));
        }
      });
    });
  }

  it('checkDaemonOrphan reports pass when no daemons', async () => {
    const result = await checkDaemonOrphan(tempDir);
    expect(result.status).toBe('pass');
  });

  it('checkDaemonOrphan fails with 2+ same-project daemons', async () => {
    const pid1 = await spawnFakeDaemon();
    const pid2 = await spawnFakeDaemon();
    const result = await checkDaemonOrphan(tempDir);
    expect(result.status).toBe('fail');
    expect(result.fix).toBe('flo healer --fix -c daemon-orphan');
    expect(result.message).toContain(String(pid1));
    expect(result.message).toContain(String(pid2));
  }, 15000);

  it('reapSameProjectOrphans kills every same-project daemon when no lock-holder', async () => {
    // The "no canonical daemon" branch of the autoFixCheck dispatcher reaps
    // every same-project PID before respawning. Verify the reap step
    // directly — the respawn step is `npx moflo daemon start` which
    // depends on a real moflo install at tempDir and is exercised by
    // daemon-command tests, not here.
    const pid1 = await spawnFakeDaemon();
    const pid2 = await spawnFakeDaemon();

    const lock = lockPath(tempDir);
    if (existsSync(lock)) rmSync(lock);

    const { survived } = reapSameProjectOrphans(tempDir);
    expect(survived).toEqual([]);
    expect(await waitForDead(pid1)).toBe(true);
    expect(await waitForDead(pid2)).toBe(true);
  }, 15000);

  it('Daemon Orphan auto-fix preserves the lock-holder', async () => {
    const pid1 = await spawnFakeDaemon();
    const pid2 = await spawnFakeDaemon();

    // Write a lock that names pid1 as the canonical daemon. The fix should
    // kill pid2 but leave pid1 alive.
    const lock = lockPath(tempDir);
    writeFileSync(
      lock,
      JSON.stringify({ pid: pid1, startedAt: Date.now(), label: 'moflo-daemon' }),
    );

    const success = await autoFixCheck({
      name: 'Daemon Orphan',
      status: 'fail',
      message: '2 daemons',
      fix: 'flo healer --fix -c daemon-orphan',
    });

    expect(await waitForDead(pid2)).toBe(true);
    expect(isAlive(pid1)).toBe(true);
    expect(success).toBe(true);

    // Post-fix the check should report pass again (only pid1 left).
    const pids = findProjectDaemonPids(tempDir);
    expect(pids).toEqual([pid1]);
  }, 20000);

  /**
   * #1431 — the fix used to root itself at `process.cwd()` while
   * `checkDaemonOrphan` walks up to the project root. Invoked from a
   * subdirectory the two disagreed: `findProjectDaemonPids(<subdir>)` returns
   * `[]`, so the handler fell through `pids.length <= 1` and returned `true`.
   * Doctor printed "Fixed: Daemon Orphan" having reaped nothing.
   *
   * Both cases below run the fix from a subdirectory with two live daemons.
   * They differ only in how the root is reachable — via `CLAUDE_PROJECT_DIR`
   * (what Claude Code sets, the dominant path) and via the marker walk with
   * the variable absent (a plain shell). Against the old handler both fail on
   * the surviving orphan.
   */
  describe('fix invoked from a subdirectory (#1431)', () => {
    async function expectOrphanReapedFromSubdir(subdir: string, pid1: number, pid2: number) {
      writeFileSync(
        lockPath(tempDir),
        JSON.stringify({ pid: pid1, startedAt: Date.now(), label: 'moflo-daemon' }),
      );
      process.chdir(subdir);

      const success = await autoFixCheck({
        name: 'Daemon Orphan',
        status: 'fail',
        message: '2 daemons',
        fix: 'flo healer --fix -c daemon-orphan',
      });

      // The orphan is gone and the lock-holder survives — i.e. the fix acted
      // on the same daemons the check counted, rather than reporting a
      // no-op success.
      expect(await waitForDead(pid2)).toBe(true);
      expect(isAlive(pid1)).toBe(true);
      expect(success).toBe(true);
    }

    it('reaps the orphan when CLAUDE_PROJECT_DIR anchors the root', async () => {
      const pid1 = await spawnFakeDaemon();
      const pid2 = await spawnFakeDaemon();
      const subdir = join(tempDir, 'packages', 'api');
      mkdirSync(subdir, { recursive: true });
      // beforeEach already anchored CLAUDE_PROJECT_DIR at tempDir.
      await expectOrphanReapedFromSubdir(subdir, pid1, pid2);
    }, 20000);

    it('reaps the orphan when the root is only reachable by the marker walk', async () => {
      const pid1 = await spawnFakeDaemon();
      const pid2 = await spawnFakeDaemon();
      const subdir = join(tempDir, 'packages', 'api');
      mkdirSync(subdir, { recursive: true });

      // Drop the env anchor so Pass A's topmost-marker walk is what resolves
      // the root, and give it the marker it looks for.
      delete process.env.CLAUDE_PROJECT_DIR;
      writeFileSync(join(tempDir, '.moflo', 'moflo.db'), '');
      process.chdir(subdir);

      // Guard: assert the walk lands on tempDir BEFORE running a fix that
      // reaps processes. If an ancestor of the OS temp dir ever carried a
      // moflo marker, "topmost wins" would resolve above tempDir — this fails
      // loudly instead of letting the reap run against a wider root.
      expect(findProjectRoot()).toBe(tempDir);

      await expectOrphanReapedFromSubdir(subdir, pid1, pid2);
    }, 20000);
  });
});
