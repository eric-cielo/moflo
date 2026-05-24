/**
 * Same-project orphan detection tests (#1150).
 *
 * Verifies:
 *   - `findProjectDaemonPids` enumerates real node processes whose command
 *     line is rooted at the test's project tempDir (consumer-install layout).
 *   - `reapSameProjectOrphans` SIGTERMs foreign-PID-same-project daemons,
 *     skipping the lock-holder and our own PID.
 *   - `acquireDaemonLock` reaps orphans pre-acquire (the second-spawn case
 *     where the lock got unlinked but the daemon stayed alive).
 *
 * Strategy: spawns a long-running node child as a "fake daemon" whose argv
 * matches the orphan matcher's expectations (`<projectRoot>/bin/cli.js`
 * + `daemon start` + `moflo`). The matcher reads the OS command line via
 * the same platform-introspection chain that production uses.
 *
 * Cross-platform note: orphan scanning is intentionally skipped under
 * vitest by default (`MOFLO_TEST_SKIP_ORPHAN_SCAN=1`, set in
 * vitest.setup.ts). These tests delete the env-var in `beforeEach` and
 * restore it after.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import {
  acquireDaemonLock,
  findProjectDaemonPids,
  lockPath,
  reapSameProjectOrphans,
} from '../../services/daemon-lock.js';

// The fake daemon script — a no-op long-running node process. Lives at
// <tempDir>/bin/cli.js so the dogfood-source path candidate matches.
const FAKE_DAEMON_SCRIPT = `
// fake moflo daemon for orphan-scan tests
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

describe('daemon-lock orphan detection (#1150)', () => {
  let tempDir: string;
  let fakeDaemons: ChildProcess[] = [];
  let priorSkipEnv: string | undefined;

  beforeEach(() => {
    priorSkipEnv = process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;
    delete process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;

    tempDir = mkdtempSync(join(tmpdir(), 'orphan-scan-'));
    mkdirSync(join(tempDir, '.moflo'), { recursive: true });
    mkdirSync(join(tempDir, 'bin'), { recursive: true });
    writeFileSync(join(tempDir, 'bin', 'cli.js'), FAKE_DAEMON_SCRIPT);
  });

  afterEach(async () => {
    for (const child of fakeDaemons) {
      try { child.kill('SIGKILL'); } catch { /* ok */ }
    }
    // Give children a beat to actually die before rmSync clobbers their cwd.
    await new Promise(r => setTimeout(r, 100));
    fakeDaemons = [];
    rmSync(tempDir, { recursive: true, force: true });

    if (priorSkipEnv !== undefined) {
      process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN = priorSkipEnv;
    }
  });

  /**
   * Spawn a fake daemon rooted at `<tempDir>/bin/cli.js`. Returns its PID
   * once we've confirmed it's alive.
   */
  function spawnFakeDaemon(): Promise<number> {
    return new Promise((resolve, reject) => {
      const cliPath = join(tempDir, 'bin', 'cli.js');
      // argv: [node, cliPath, 'daemon', 'start']. The matcher needs all of:
      //   - moflo or claude-flow somewhere in cmdline (cliPath includes 'moflo'? no — tempDir might not.
      //     Need to ensure 'moflo' is in cmdline. Add it as a tag arg.)
      //   - 'daemon start' substring
      //   - tempDir path substring
      // Detached + unref so init/launchd is the child's reaper instead of
      // the test parent — when the test parent's event loop is blocked by
      // sleepSyncMs in `terminateOrphan`, an internally-reaped zombie
      // would otherwise keep `kill(pid, 0)` returning success forever and
      // bust the kill-window poll. /proc/<pid>/stat handles this on Linux
      // but macOS has no /proc, so the detach is the macOS-safe path.
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
          fakeDaemons.push(child);
          if (process.platform !== 'win32') child.unref();
          // Give the process a moment to show up in /proc and ps listings.
          setTimeout(() => resolve(child.pid!), 200);
        } else {
          reject(new Error('spawn returned no pid'));
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // findProjectDaemonPids — pure matching logic
  // ---------------------------------------------------------------------
  //
  // These cases exercise the matcher (`projectCliCandidates` +
  // `cmdlineMatchesProject`), NOT the OS-introspection chain. They inject a
  // synthetic process list through the production `pidsHint` seam instead of
  // spawning a real process and triggering a machine-wide scan.
  //
  // Why: under full-suite load the real Windows scan
  // (`Get-CimInstance Win32_Process -Filter Name='node.exe'` via a cold
  // PowerShell) is slow enough to blow the per-test budget — a timeout vitest
  // surfaces under the test's name, masquerading as an assertion failure.
  // That's the same "execSync introspection starves under parallel vitest
  // workers" class #1086 fixed for `isDaemonProcess` via
  // `MOFLO_TEST_TRUST_DAEMON_PID`. Injection makes these matcher tests
  // deterministic, instant, and immune to PID reuse / sibling-test
  // contamination. The real scan + real SIGTERM path stays covered
  // end-to-end by the `reapSameProjectOrphans` / `acquireDaemonLock` tests
  // below, which spawn and reap real processes (so `listMofloDaemons*` is
  // still exercised transitively).
  describe('findProjectDaemonPids', () => {
    function hintFor(root: string, pid: number): Array<{ pid: number; cmdline: string }> {
      // Build the cmdline from the realpath'd cli.js so it matches the
      // realpath-normalised candidate the matcher derives (Windows 8.3 /
      // symlink resolution + case-folding handled by both sides).
      const cli = realpathSync(join(root, 'bin', 'cli.js'));
      return [{ pid, cmdline: `"${process.execPath}" ${cli} daemon start --moflo-fake-tag` }];
    }

    it('returns empty array when MOFLO_TEST_SKIP_ORPHAN_SCAN=1 (skip wins over a matching hint)', () => {
      const hint = hintFor(tempDir, 4242);
      process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN = '1';
      try {
        expect(findProjectDaemonPids(tempDir, { pidsHint: hint })).toEqual([]);
      } finally {
        delete process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;
      }
    });

    it('detects a same-project daemon', () => {
      const hint = hintFor(tempDir, 4242);
      expect(findProjectDaemonPids(tempDir, { pidsHint: hint })).toContain(4242);
    });

    it('does NOT detect a daemon rooted at a different project path', () => {
      const hint = hintFor(tempDir, 4242);
      // Probe with a different project root — the tempDir-rooted daemon must
      // not match. This is the exact assertion that flaked under load when it
      // depended on a real machine-wide scan.
      const otherDir = mkdtempSync(join(tmpdir(), 'orphan-scan-other-'));
      mkdirSync(join(otherDir, 'bin'), { recursive: true });
      writeFileSync(join(otherDir, 'bin', 'cli.js'), FAKE_DAEMON_SCRIPT);
      try {
        expect(findProjectDaemonPids(otherDir, { pidsHint: hint })).not.toContain(4242);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------
  // reapSameProjectOrphans
  // ---------------------------------------------------------------------
  describe('reapSameProjectOrphans', () => {
    it('terminates a foreign-PID same-project daemon', async () => {
      const pid = await spawnFakeDaemon();
      const { reaped, survived } = reapSameProjectOrphans(tempDir, process.pid);
      expect(survived).toEqual([]);
      expect(reaped).toContain(pid);
      expect(await waitForDead(pid)).toBe(true);
    }, 15000);

    it('skips the lock-holder PID', async () => {
      const pid = await spawnFakeDaemon();
      // Pretend the lock points at the fake daemon; reap must not touch it.
      const result = reapSameProjectOrphans(tempDir, process.pid, pid);
      expect(result.reaped).not.toContain(pid);
      expect(isAlive(pid)).toBe(true);
    }, 15000);

    it('skips our own PID', async () => {
      // The current vitest worker process won't match the orphan filter
      // (no `daemon start` + `moflo` in its cmdline), but the explicit
      // `ownPid` filter is a defense-in-depth guard the contract relies on.
      const pid = await spawnFakeDaemon();
      const result = reapSameProjectOrphans(tempDir, pid /* pretend it's us */);
      expect(result.reaped).not.toContain(pid);
    }, 15000);
  });

  // ---------------------------------------------------------------------
  // acquireDaemonLock pre-acquire reap
  // ---------------------------------------------------------------------
  describe('acquireDaemonLock pre-acquire reap', () => {
    it('reaps an orphan when the lock is absent (second-spawn case)', async () => {
      const pid = await spawnFakeDaemon();
      // Simulate the bug: a daemon is alive but the lock got unlinked.
      const lock = lockPath(tempDir);
      if (existsSync(lock)) rmSync(lock);

      const result = acquireDaemonLock(tempDir);
      expect(result.acquired).toBe(true);
      expect(await waitForDead(pid)).toBe(true);
    }, 15000);

    it('does not reap a foreign-project daemon', async () => {
      const pid = await spawnFakeDaemon();

      // Acquire the lock in a different project tempDir — fake daemon for
      // tempDir must NOT be killed.
      const otherDir = mkdtempSync(join(tmpdir(), 'orphan-scan-other-acquire-'));
      mkdirSync(join(otherDir, '.moflo'), { recursive: true });
      try {
        const result = acquireDaemonLock(otherDir);
        expect(result.acquired).toBe(true);
        expect(isAlive(pid)).toBe(true);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    }, 15000);
  });
});
