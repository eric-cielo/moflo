/**
 * Unit tests for `resolveDashboardPort` — the port precedence helper used by
 * `flo daemon start`. Verifies the asymmetry fix for #1067: the daemon server
 * now honors `MOFLO_DAEMON_PORT` env, matching `daemon-write-client.ts`.
 */

import { describe, it, expect } from 'vitest';
import { resolveDashboardPort } from '../../commands/daemon.js';
import { DEFAULT_DASHBOARD_PORT } from '../../services/daemon-dashboard.js';

describe('resolveDashboardPort (#1067)', () => {
  it('returns DEFAULT_DASHBOARD_PORT when neither flag nor env is set', () => {
    const r = resolveDashboardPort(undefined, undefined);
    expect(r).toEqual({ ok: true, port: DEFAULT_DASHBOARD_PORT });
  });

  it('honors MOFLO_DAEMON_PORT env when --dashboard-port flag is absent', () => {
    const r = resolveDashboardPort(undefined, '3217');
    expect(r).toEqual({ ok: true, port: 3217 });
  });

  it('--dashboard-port flag wins over MOFLO_DAEMON_PORT env', () => {
    const r = resolveDashboardPort('4000', '3217');
    expect(r).toEqual({ ok: true, port: 4000 });
  });

  it('rejects invalid --dashboard-port flag value', () => {
    const r = resolveDashboardPort('not-a-number', undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('dashboard port');
  });

  it('rejects invalid MOFLO_DAEMON_PORT env value with the env label', () => {
    const r = resolveDashboardPort(undefined, 'abc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('MOFLO_DAEMON_PORT');
  });

  it('rejects out-of-range port (0)', () => {
    const r = resolveDashboardPort('0', undefined);
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-range port (65536)', () => {
    const r = resolveDashboardPort('65536', undefined);
    expect(r.ok).toBe(false);
  });

  it('accepts port 1 and 65535 (range edges)', () => {
    expect(resolveDashboardPort('1', undefined)).toEqual({ ok: true, port: 1 });
    expect(resolveDashboardPort('65535', undefined)).toEqual({ ok: true, port: 65535 });
  });
});
