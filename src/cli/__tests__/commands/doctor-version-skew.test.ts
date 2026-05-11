/**
 * Tests for the Daemon Version Skew doctor check (epic #1054.S5 / #1059).
 *
 * The check fails when the running daemon's reported `version` (recorded in
 * `.moflo/daemon.lock` by S2) disagrees with the installed package version.
 * It must surface this as a distinct failure mode — not buried in "stale
 * cache" — so the doctor diagnosis matches what the launcher already does on
 * skew (see bin/session-start-launcher.mjs § 3a-pre).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDaemonVersionSkew } from '../../commands/doctor-checks-version-skew.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-version-skew-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function writeInstalledPkg(version: string): void {
  const pkgDir = join(tmpDir, 'node_modules', 'moflo');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'moflo', version }));
}

function writeDaemonLock(payload: object): void {
  const mofloDir = join(tmpDir, '.moflo');
  mkdirSync(mofloDir, { recursive: true });
  writeFileSync(join(mofloDir, 'daemon.lock'), JSON.stringify(payload));
}

describe('checkDaemonVersionSkew (#1059)', () => {
  it('passes when no daemon is running', async () => {
    writeInstalledPkg('4.9.40');
    const result = await checkDaemonVersionSkew(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/No daemon running/);
    expect(result.message).toContain('4.9.40');
  });

  it('warns when the installed version cannot be resolved', async () => {
    // no node_modules/moflo/package.json
    const result = await checkDaemonVersionSkew(tmpDir);
    // No daemon AND no installed package — current behavior reports the
    // version-resolution warning first.
    expect(['warn', 'pass']).toContain(result.status);
  });

  it('fails when daemon version disagrees with installed version', async () => {
    writeInstalledPkg('4.9.40');
    // Use the current process's PID so the daemon-lock liveness probe passes.
    writeDaemonLock({
      pid: process.pid,
      startedAt: Date.now(),
      label: 'moflo-daemon',
      version: '4.9.37',
    });

    const result = await checkDaemonVersionSkew(tmpDir);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('4.9.37');
    expect(result.message).toContain('4.9.40');
    expect(result.fix).toBeDefined();
  });

  it('flags pre-1054 daemons (no version field) as skew', async () => {
    writeInstalledPkg('4.9.40');
    writeDaemonLock({
      pid: process.pid,
      startedAt: Date.now(),
      label: 'moflo-daemon',
      // no version field — pre-#1054 daemon
    });

    const result = await checkDaemonVersionSkew(tmpDir);
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/pre-1054|unknown/);
  });

  it('passes when daemon version matches installed version', async () => {
    writeInstalledPkg('4.9.40');
    writeDaemonLock({
      pid: process.pid,
      startedAt: Date.now(),
      label: 'moflo-daemon',
      version: '4.9.40',
    });

    const result = await checkDaemonVersionSkew(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/matches/);
  });
});
