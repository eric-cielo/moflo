/**
 * `Daemon Orphan` healer check + auto-fix test (#1150).
 *
 * Spawns a real same-project fake daemon process so the platform
 * introspection chain (Get-CimInstance on Windows, `/proc` on Linux,
 * `ps` on macOS) exercises end-to-end. Confirms the check transitions
 * pass → fail → pass across the spawn-and-fix cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { autoFixCheck } from '../../commands/doctor-fixes.js';
import { checkDaemonOrphan } from '../../commands/doctor-checks-config.js';
import { findProjectDaemonPids, lockPath, reapSameProjectOrphans } from '../../services/daemon-lock.js';

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
  let children: ChildProcess[] = [];

  beforeEach(() => {
    priorSkip = process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;
    delete process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN;

    priorCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'orphan-fix-'));
    mkdirSync(join(tempDir, '.moflo'), { recursive: true });
    mkdirSync(join(tempDir, 'bin'), { recursive: true });
    writeFileSync(join(tempDir, 'bin', 'cli.js'), FAKE_DAEMON_SCRIPT);
    process.chdir(tempDir);
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
  });

  function spawnFakeDaemon(): Promise<number> {
    return new Promise((resolve, reject) => {
      const cliPath = join(tempDir, 'bin', 'cli.js');
      const child = spawn(
        process.execPath,
        [cliPath, 'daemon', 'start', '--moflo-fake-daemon-tag'],
        { cwd: tempDir, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
      );
      child.on('error', reject);
      child.on('spawn', () => {
        if (child.pid) {
          children.push(child);
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
});
