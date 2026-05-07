/**
 * Daemon Readiness Tests
 *
 * Validates the daemon-running check for scheduled spells. OS-autostart
 * install/uninstall is now driven by the enabled-schedule count via
 * `reconcileDaemonAutostart` — see daemon-autostart-lifecycle.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureDaemonForScheduling } from '../../services/daemon-readiness.js';

// Mock dependencies
vi.mock('../../services/daemon-lock.js', () => ({
  getDaemonLockHolder: vi.fn(),
}));

vi.mock('../../services/daemon-service.js', () => ({
  isDaemonInstalled: vi.fn(),
}));

import { getDaemonLockHolder } from '../../services/daemon-lock.js';
import { isDaemonInstalled } from '../../services/daemon-service.js';

const mockGetHolder = vi.mocked(getDaemonLockHolder);
const mockIsInstalled = vi.mocked(isDaemonInstalled);

describe('ensureDaemonForScheduling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns clean result when daemon is running and installed', async () => {
    mockGetHolder.mockReturnValue(12345);
    mockIsInstalled.mockReturnValue(true);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: vi.fn(),
      startDaemon: vi.fn(),
    });

    expect(result.daemonRunning).toBe(true);
    expect(result.daemonInstalled).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('reports daemonInstalled informationally without prompting', async () => {
    // Install state is reported but never triggers a prompt — the install
    // side-effect is now driven by reconcileDaemonAutostart, not by
    // ensureDaemonForScheduling. See #960.
    mockGetHolder.mockReturnValue(12345);
    mockIsInstalled.mockReturnValue(false);

    const promptFn = vi.fn();
    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: vi.fn(),
    });

    expect(result.daemonRunning).toBe(true);
    expect(result.daemonInstalled).toBe(false);
    // No install prompt — the only prompt this function ever issues is to
    // start a stopped daemon.
    expect(promptFn).not.toHaveBeenCalled();
    expect(result.warnings).toHaveLength(0);
  });

  it('prompts to start daemon when not running (interactive, accepts)', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(true);

    const promptFn = vi.fn().mockResolvedValue(true);
    const startFn = vi.fn().mockResolvedValue(true);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: startFn,
    });

    expect(result.daemonRunning).toBe(true);
    expect(result.daemonInstalled).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(promptFn).toHaveBeenCalledWith(expect.stringContaining('Start it now'));
    expect(startFn).toHaveBeenCalledWith(expect.any(String));
  });

  it('warns when user declines to start daemon (interactive)', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(false);

    const promptFn = vi.fn().mockResolvedValue(false);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: vi.fn(),
    });

    expect(result.daemonRunning).toBe(false);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toContain('will not run until the daemon starts');
  });

  it('warns when daemon start fails (interactive)', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(false);

    const promptFn = vi.fn().mockResolvedValue(true);
    const startFn = vi.fn().mockResolvedValue(false);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: startFn,
    });

    expect(result.daemonRunning).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('Failed to start daemon'));
  });

  it('warns about daemon-not-running in non-interactive mode without prompting', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(false);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: false,
    });

    expect(result.daemonRunning).toBe(false);
    expect(result.daemonInstalled).toBe(false);
    // Only the daemon-not-running warning — autostart is no longer surfaced
    // here (the autostart lifecycle handles that side-effect).
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('moflo daemon start');
  });

  it('reports installed=true even when daemon is down', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(true);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: false,
    });

    expect(result.daemonRunning).toBe(false);
    expect(result.daemonInstalled).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('moflo daemon start');
  });
});
