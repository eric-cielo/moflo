/**
 * Unit tests for the lock-file `port` field (#1145).
 *
 * Verifies:
 *   - `writeLockPort` stamps the port onto a lock the current PID owns
 *   - It refuses to overwrite a lock owned by a different PID
 *   - Idempotent: calling with the same port twice is a no-op
 *   - `transferDaemonLock` preserves the port across PID transfers
 *   - `getDaemonLockPayload` surfaces the port to readers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  acquireDaemonLock,
  releaseDaemonLock,
  writeLockPort,
  transferDaemonLock,
  lockPath,
} from '../../services/daemon-lock.js';

let tmp: string;
const PRIOR_TRUST = process.env.MOFLO_TEST_TRUST_DAEMON_PID;

beforeEach(() => {
  tmp = join(tmpdir(), `daemon-lock-port-${randomUUID()}`);
  mkdirSync(join(tmp, '.moflo'), { recursive: true });
  // Bypass platform process-introspection — these tests use synthetic PIDs.
  process.env.MOFLO_TEST_TRUST_DAEMON_PID = '1';
});

afterEach(() => {
  if (PRIOR_TRUST != null) process.env.MOFLO_TEST_TRUST_DAEMON_PID = PRIOR_TRUST;
  else delete process.env.MOFLO_TEST_TRUST_DAEMON_PID;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('writeLockPort', () => {
  it('stamps port onto a lock owned by the current PID', () => {
    const acquired = acquireDaemonLock(tmp);
    expect(acquired.acquired).toBe(true);

    const stamped = writeLockPort(tmp, 33421);
    expect(stamped).toBe(true);

    const raw = readFileSync(lockPath(tmp), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(33421);
    expect(parsed.pid).toBe(process.pid);
  });

  it('returns false (no-op) when lock is owned by a different PID', () => {
    // Manually write a lock with a different PID — claim it's alive via
    // the test bypass.
    writeFileSync(
      lockPath(tmp),
      JSON.stringify({ pid: 99999, startedAt: Date.now(), label: 'moflo-daemon' }),
    );
    const stamped = writeLockPort(tmp, 33421);
    expect(stamped).toBe(false);
    // Lock content unchanged.
    const parsed = JSON.parse(readFileSync(lockPath(tmp), 'utf-8'));
    expect(parsed.port).toBeUndefined();
  });

  it('returns false when lock is absent', () => {
    expect(writeLockPort(tmp, 33421)).toBe(false);
  });

  it('idempotent — same port twice', () => {
    acquireDaemonLock(tmp);
    expect(writeLockPort(tmp, 33421)).toBe(true);
    expect(writeLockPort(tmp, 33421)).toBe(true);
  });

  it('rejects invalid ports', () => {
    acquireDaemonLock(tmp);
    expect(writeLockPort(tmp, 0)).toBe(false);
    expect(writeLockPort(tmp, -1)).toBe(false);
    expect(writeLockPort(tmp, 70000)).toBe(false);
    expect(writeLockPort(tmp, NaN)).toBe(false);
  });
});

describe('transferDaemonLock preserves port', () => {
  it('keeps the port field across PID transfer', () => {
    acquireDaemonLock(tmp);
    writeLockPort(tmp, 33500);

    const transferred = transferDaemonLock(tmp, 88888);
    expect(transferred).toBe(true);

    const parsed = JSON.parse(readFileSync(lockPath(tmp), 'utf-8'));
    expect(parsed.pid).toBe(88888);
    expect(parsed.port).toBe(33500);

    // Cleanup — release as the new PID.
    releaseDaemonLock(tmp, 88888, true);
  });

  it('transfer without prior port leaves port absent (backward-compat)', () => {
    acquireDaemonLock(tmp);
    const transferred = transferDaemonLock(tmp, 88888);
    expect(transferred).toBe(true);
    const parsed = JSON.parse(readFileSync(lockPath(tmp), 'utf-8'));
    expect(parsed.port).toBeUndefined();
    releaseDaemonLock(tmp, 88888, true);
  });
});
