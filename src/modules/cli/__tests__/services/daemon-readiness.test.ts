/**
 * Daemon Readiness Tests
 *
 * Validates the three-state lazy daemon check for scheduled workflows:
 * 1. Daemon running + installed → no prompts, clean result
 * 2. Daemon running + not installed (interactive) → prompts to install
 * 3. Daemon running + not installed (non-interactive) → warns
 * 4. Daemon not running (interactive) → prompts to start, then checks install
 * 5. Daemon not running (non-interactive) → warns
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureDaemonForScheduling } from '../../src/services/daemon-readiness.js';

// Mock dependencies
vi.mock('../../src/services/daemon-lock.js', () => ({
  getDaemonLockHolder: vi.fn(),
}));

vi.mock('../../src/services/daemon-service.js', () => ({
  isDaemonInstalled: vi.fn(),
  installDaemonService: vi.fn(),
}));

import { getDaemonLockHolder } from '../../src/services/daemon-lock.js';
import { isDaemonInstalled, installDaemonService } from '../../src/services/daemon-service.js';

const mockGetHolder = vi.mocked(getDaemonLockHolder);
const mockIsInstalled = vi.mocked(isDaemonInstalled);
const mockInstall = vi.mocked(installDaemonService);

describe('ensureDaemonForScheduling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── State 1: Daemon running + installed ───────────────────────────────────

  it('should return clean result when daemon is running and installed', async () => {
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

  // ── State 2: Daemon running + not installed (interactive) ─────────────────

  it('should prompt to install when daemon is running but not installed (interactive, accepts)', async () => {
    mockGetHolder.mockReturnValue(12345);
    mockIsInstalled.mockReturnValue(false);
    mockInstall.mockReturnValue({ success: true, servicePath: '/test/service', message: 'Installed' });

    const promptFn = vi.fn().mockResolvedValue(true);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: vi.fn(),
    });

    expect(result.daemonRunning).toBe(true);
    expect(result.daemonInstalled).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(promptFn).toHaveBeenCalledWith(
      expect.stringContaining('login service'),
    );
    expect(mockInstall).toHaveBeenCalledWith(expect.any(String));
  });

  it('should warn when user declines install (interactive)', async () => {
    mockGetHolder.mockReturnValue(12345);
    mockIsInstalled.mockReturnValue(false);

    const promptFn = vi.fn().mockResolvedValue(false);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: vi.fn(),
    });

    expect(result.daemonRunning).toBe(true);
    expect(result.daemonInstalled).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('reboot');
  });

  // ── State 3: Daemon running + not installed (non-interactive) ─────────────

  it('should warn without prompting in non-interactive mode', async () => {
    mockGetHolder.mockReturnValue(12345);
    mockIsInstalled.mockReturnValue(false);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: false,
    });

    expect(result.daemonRunning).toBe(true);
    expect(result.daemonInstalled).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('moflo daemon install');
  });

  // ── State 4: Daemon not running (interactive) ─────────────────────────────

  it('should prompt to start daemon when not running (interactive, accepts)', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(true); // already installed as OS service

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
    expect(promptFn).toHaveBeenCalledWith(
      expect.stringContaining('Start it now'),
    );
    expect(startFn).toHaveBeenCalledWith(expect.any(String));
  });

  it('should warn when user declines to start daemon (interactive)', async () => {
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

  it('should warn when daemon start fails (interactive)', async () => {
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
    expect(result.warnings).toContainEqual(
      expect.stringContaining('Failed to start daemon'),
    );
  });

  // ── State 5: Daemon not running (non-interactive) ─────────────────────────

  it('should warn without prompting when daemon not running (non-interactive)', async () => {
    mockGetHolder.mockReturnValue(null);
    mockIsInstalled.mockReturnValue(false);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: false,
    });

    expect(result.daemonRunning).toBe(false);
    // Only one warning: daemon not running. Install check is skipped because
    // the daemon isn't running — no point warning about service registration.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('moflo daemon start');
  });

  // ── Install failure ───────────────────────────────────────────────────────

  it('should warn when install fails (interactive)', async () => {
    mockGetHolder.mockReturnValue(12345);
    mockIsInstalled.mockReturnValue(false);
    mockInstall.mockReturnValue({ success: false, servicePath: null, message: 'Permission denied' });

    const promptFn = vi.fn().mockResolvedValue(true);

    const result = await ensureDaemonForScheduling({
      projectRoot: '/test/project',
      interactive: true,
      promptConfirm: promptFn,
      startDaemon: vi.fn(),
    });

    expect(result.daemonInstalled).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringContaining('Permission denied'),
    );
  });
});
