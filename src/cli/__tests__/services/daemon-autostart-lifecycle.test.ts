/**
 * Daemon Autostart Lifecycle Tests
 *
 * Validates `reconcileDaemonAutostart` — the count-based replacement for the
 * old prompt-driven install flow (#960, #961). Covers all four canonical
 * transitions plus the opt-out flag.
 */

import { describe, it, expect, vi } from 'vitest';
import { reconcileDaemonAutostart } from '../../services/daemon-autostart-lifecycle.js';

describe('reconcileDaemonAutostart', () => {
  // ── 0 → 1: install on first enabled schedule ─────────────────────────────

  it('installs the OS service when count goes from 0 to 1', () => {
    const install = vi.fn().mockReturnValue({ success: true, servicePath: '/srv', message: 'ok' });
    const uninstall = vi.fn();

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 1,
      isDaemonInstalled: () => false,
      installDaemonService: install,
      uninstallDaemonService: uninstall,
    });

    expect(result.transition).toBe('installed');
    expect(result.message).toContain('survives reboot');
    expect(install).toHaveBeenCalledWith('/test/project');
    expect(uninstall).not.toHaveBeenCalled();
  });

  // ── 1 → 2: idempotent (already installed) ────────────────────────────────

  it('is a no-op when count goes 1 → 2 and service is already installed', () => {
    const install = vi.fn();
    const uninstall = vi.fn();

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 2,
      isDaemonInstalled: () => true,
      installDaemonService: install,
      uninstallDaemonService: uninstall,
    });

    expect(result.transition).toBe('noop');
    expect(result.message).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  // ── 2 → 1: still has schedules, no-op ────────────────────────────────────

  it('is a no-op when count goes 2 → 1 and service is installed', () => {
    const install = vi.fn();
    const uninstall = vi.fn();

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 1,
      isDaemonInstalled: () => true,
      installDaemonService: install,
      uninstallDaemonService: uninstall,
    });

    expect(result.transition).toBe('noop');
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  // ── 1 → 0: uninstall when last schedule is removed ───────────────────────

  it('uninstalls the OS service when count goes from 1 to 0', () => {
    const install = vi.fn();
    const uninstall = vi.fn().mockReturnValue({ success: true, message: 'removed' });

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 0,
      isDaemonInstalled: () => true,
      installDaemonService: install,
      uninstallDaemonService: uninstall,
    });

    expect(result.transition).toBe('uninstalled');
    expect(result.message).toContain('No enabled schedules remain');
    expect(uninstall).toHaveBeenCalledWith('/test/project');
    expect(install).not.toHaveBeenCalled();
  });

  // ── 0 → 0: never installed, no-op ────────────────────────────────────────

  it('is a no-op when count is 0 and service was never installed', () => {
    const install = vi.fn();
    const uninstall = vi.fn();

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 0,
      isDaemonInstalled: () => false,
      installDaemonService: install,
      uninstallDaemonService: uninstall,
    });

    expect(result.transition).toBe('noop');
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  // ── Opt-out ──────────────────────────────────────────────────────────────

  it('skips install when opt-out flag is set (--no-autostart)', () => {
    const install = vi.fn();

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 1,
      isDaemonInstalled: () => false,
      installDaemonService: install,
      uninstallDaemonService: vi.fn(),
      skip: true,
    });

    expect(result.transition).toBe('noop');
    expect(install).not.toHaveBeenCalled();
  });

  it('skips uninstall when opt-out flag is set (--keep-autostart)', () => {
    const uninstall = vi.fn();

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 0,
      isDaemonInstalled: () => true,
      installDaemonService: vi.fn(),
      uninstallDaemonService: uninstall,
      skip: true,
    });

    expect(result.transition).toBe('noop');
    expect(uninstall).not.toHaveBeenCalled();
  });

  // ── Failure surfacing ────────────────────────────────────────────────────

  it('returns a warning (not transition) when install fails', () => {
    const install = vi.fn().mockReturnValue({ success: false, servicePath: null, message: 'permission denied' });

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 1,
      isDaemonInstalled: () => false,
      installDaemonService: install,
      uninstallDaemonService: vi.fn(),
    });

    expect(result.transition).toBe('noop');
    expect(result.warning).toContain('permission denied');
  });

  it('returns a warning (not transition) when uninstall fails', () => {
    const uninstall = vi.fn().mockReturnValue({ success: false, message: 'systemctl not found' });

    const result = reconcileDaemonAutostart({
      projectRoot: '/test/project',
      enabledScheduleCount: 0,
      isDaemonInstalled: () => true,
      installDaemonService: vi.fn(),
      uninstallDaemonService: uninstall,
    });

    expect(result.transition).toBe('noop');
    expect(result.warning).toContain('systemctl not found');
  });
});
