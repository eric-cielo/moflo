/**
 * Unit tests for `src/cli/services/daemon-port.ts` (#1145).
 *
 * Pure-function tests — no daemon spin-up. Covers:
 *   - Env override precedence (`MOFLO_DAEMON_PORT`)
 *   - Deterministic hash → port range
 *   - Lock-file `port` field discovery
 *   - Server candidate ordering + wrap behavior
 *   - JS twin (`bin/lib/daemon-port.mjs`) algorithmic parity
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  PORT_RANGE_BASE,
  PORT_RANGE_SIZE,
  LEGACY_DEFAULT_PORT,
  resolveProjectPort,
  resolveClientPort,
  serverPortCandidates,
  readEnvPortOverride,
} from '../../services/daemon-port.js';

const PRIOR_ENV = process.env.MOFLO_DAEMON_PORT;

beforeEach(() => { delete process.env.MOFLO_DAEMON_PORT; });
afterEach(() => {
  if (PRIOR_ENV != null) process.env.MOFLO_DAEMON_PORT = PRIOR_ENV;
  else delete process.env.MOFLO_DAEMON_PORT;
});

describe('resolveProjectPort', () => {
  it('returns a port in [33000, 34000)', () => {
    const port = resolveProjectPort('/some/project');
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_BASE);
    expect(port).toBeLessThan(PORT_RANGE_BASE + PORT_RANGE_SIZE);
  });

  it('is deterministic — same input → same output', () => {
    const a = resolveProjectPort('/path/to/foo');
    const b = resolveProjectPort('/path/to/foo');
    expect(a).toBe(b);
  });

  it('produces different ports for different roots', () => {
    // Hash collisions in a 1000-port range are possible — pick paths that
    // we've verified avoid them. If this becomes flaky, the algorithm
    // changed and the JS-twin test will catch it too.
    const a = resolveProjectPort('/project-a');
    const b = resolveProjectPort('/project-b');
    const c = resolveProjectPort('/project-c-totally-distinct');
    // At least one pair must differ.
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it('honors MOFLO_DAEMON_PORT env override', () => {
    process.env.MOFLO_DAEMON_PORT = '54321';
    expect(resolveProjectPort('/any/path')).toBe(54321);
  });

  it('ignores malformed env override and falls back to deterministic', () => {
    process.env.MOFLO_DAEMON_PORT = 'not-a-port';
    const port = resolveProjectPort('/some/path');
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_BASE);
    expect(port).toBeLessThan(PORT_RANGE_BASE + PORT_RANGE_SIZE);
  });

  it('rejects env values outside 1-65535', () => {
    process.env.MOFLO_DAEMON_PORT = '70000';
    expect(readEnvPortOverride()).toBeNull();
    process.env.MOFLO_DAEMON_PORT = '0';
    expect(readEnvPortOverride()).toBeNull();
    process.env.MOFLO_DAEMON_PORT = '-5';
    expect(readEnvPortOverride()).toBeNull();
  });
});

describe('resolveClientPort', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `daemon-port-test-${randomUUID()}`);
    mkdirSync(join(tmp, '.moflo'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads port from daemon.lock when present', () => {
    writeFileSync(
      join(tmp, '.moflo', 'daemon.lock'),
      JSON.stringify({ pid: 12345, startedAt: Date.now(), label: 'moflo-daemon', port: 33421 }),
    );
    expect(resolveClientPort(tmp)).toBe(33421);
  });

  it('falls back to resolveProjectPort when lock has no port field', () => {
    writeFileSync(
      join(tmp, '.moflo', 'daemon.lock'),
      JSON.stringify({ pid: 12345, startedAt: Date.now(), label: 'moflo-daemon' }),
    );
    expect(resolveClientPort(tmp)).toBe(resolveProjectPort(tmp));
  });

  it('falls back when lock is corrupt', () => {
    writeFileSync(join(tmp, '.moflo', 'daemon.lock'), '{ not valid json');
    expect(resolveClientPort(tmp)).toBe(resolveProjectPort(tmp));
  });

  it('falls back when lock is absent', () => {
    expect(resolveClientPort(tmp)).toBe(resolveProjectPort(tmp));
  });

  it('env override beats lock-file port', () => {
    process.env.MOFLO_DAEMON_PORT = '40000';
    writeFileSync(
      join(tmp, '.moflo', 'daemon.lock'),
      JSON.stringify({ pid: 1, startedAt: 1, label: 'moflo-daemon', port: 33333 }),
    );
    expect(resolveClientPort(tmp)).toBe(40000);
  });

  it('rejects malformed port in lock', () => {
    writeFileSync(
      join(tmp, '.moflo', 'daemon.lock'),
      JSON.stringify({ pid: 1, startedAt: 1, label: 'moflo-daemon', port: 99999 }),
    );
    // 99999 is > 65535, so it falls back to deterministic
    expect(resolveClientPort(tmp)).toBe(resolveProjectPort(tmp));
  });
});

describe('serverPortCandidates', () => {
  it('returns deterministic port first, then offsets', () => {
    const ports = serverPortCandidates('/some/project', 5);
    expect(ports.length).toBe(5);
    expect(ports[0]).toBe(resolveProjectPort('/some/project'));
    // Each successive port is adjacent (modulo wrap).
    for (let i = 1; i < ports.length; i++) {
      const expected = PORT_RANGE_BASE + ((ports[0] - PORT_RANGE_BASE + i) % PORT_RANGE_SIZE);
      expect(ports[i]).toBe(expected);
    }
  });

  it('honors env override — collapses to single candidate', () => {
    process.env.MOFLO_DAEMON_PORT = '12345';
    expect(serverPortCandidates('/anywhere', 10)).toEqual([12345]);
  });

  it('caps attempts at PORT_RANGE_SIZE', () => {
    const ports = serverPortCandidates('/x', 2000);
    expect(ports.length).toBe(PORT_RANGE_SIZE);
  });

  it('all candidates stay in [33000, 34000)', () => {
    const ports = serverPortCandidates('/y', 100);
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(PORT_RANGE_BASE);
      expect(p).toBeLessThan(PORT_RANGE_BASE + PORT_RANGE_SIZE);
    }
  });
});

describe('LEGACY_DEFAULT_PORT', () => {
  it('is 3117 (pre-#1145 default — read-only fallback)', () => {
    expect(LEGACY_DEFAULT_PORT).toBe(3117);
  });
});

describe('JS twin parity (bin/lib/daemon-port.mjs)', () => {
  it('produces the same port as the TS resolver', async () => {
    // Dynamic import so vitest doesn't try to type-check the JS twin.
    const jsTwin = await import('../../../../bin/lib/daemon-port.mjs');
    const testPaths = [
      '/project-a',
      '/project-b-unique',
      'C:\\Users\\eric\\Projects\\moflo',
      '/Users/eric/Projects/motailz/code',
    ];
    for (const p of testPaths) {
      expect(jsTwin.resolveProjectPort(p)).toBe(resolveProjectPort(p));
    }
  });

  it('JS twin exports same range constants', async () => {
    const jsTwin = await import('../../../../bin/lib/daemon-port.mjs');
    expect(jsTwin.PORT_RANGE_BASE).toBe(PORT_RANGE_BASE);
    expect(jsTwin.PORT_RANGE_SIZE).toBe(PORT_RANGE_SIZE);
    expect(jsTwin.LEGACY_DEFAULT_PORT).toBe(LEGACY_DEFAULT_PORT);
  });
});
