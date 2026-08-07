/**
 * Daemon Service Tests
 *
 * Validates OS-native service installation/uninstallation
 * for macOS (launchd), Linux (systemd), and Windows (schtasks).
 *
 * These are UNIT tests: the process boundary (`runCommand`) and the home
 * directory (`homeDir`) are both injected, so no test here invokes the host's
 * service manager or writes outside its temp dir. That is deliberate (#1412):
 *
 *  - The real calls carry 10s (systemctl) / 15s (schtasks) subprocess timeouts,
 *    double vitest's 5s per-test budget. A single slow `systemctl --user` under
 *    full-suite contention could not be absorbed, so the file timed out
 *    intermittently while passing in isolation. Asserting the commands that
 *    *would* be issued removes the wait entirely rather than hiding it behind a
 *    raised timeout.
 *  - `systemctl --user enable/disable/stop` and the plist write were not
 *    sandboxed — running the suite on a Linux workstation performed real
 *    service registration in the developer's systemd user session.
 *
 * Injecting `platform` also makes all three branches assertable from any host,
 * which the old `process.platform` override could not do for Windows (schtasks
 * does not exist on POSIX). The genuinely integration-level path — real
 * `execSync`, real systemd — lives in `tests/system/daemon-service-systemd.test.ts`
 * with a timeout above the subprocess ceiling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { basename, join, sep } from 'path';
import { tmpdir } from 'os';

// Import internals for testing
import {
  isDaemonInstalled,
  installDaemonService,
  uninstallDaemonService,
  _generatePlist,
  _generateSystemdUnit,
  _schtasksName,
  _projectRootSlug,
  type CommandRunner,
} from '../../services/daemon-service.js';

/**
 * Recording stand-in for `execSync`. Records the command and returns — the
 * whole point is that no subprocess is spawned, so nothing here can wait.
 * `failWith` reproduces the non-zero-exit path (execSync throws) for the
 * branches that swallow service-manager errors.
 */
function recordingRunner(failWith?: Error): { runCommand: CommandRunner; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    runCommand: (command) => {
      commands.push(command);
      if (failWith) throw failWith;
    },
  };
}

describe('daemon-service', () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'daemon-service-test-'));
    homeDir = mkdtempSync(join(tmpdir(), 'daemon-service-home-'));
    mkdirSync(join(tempDir, '.moflo'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  // =========================================================================
  // projectRootSlug
  // =========================================================================
  describe('projectRootSlug', () => {
    it('should create a filesystem-safe slug', () => {
      const slug = _projectRootSlug('/home/user/my-project');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length).toBeLessThanOrEqual(60);
    });

    it('should produce different slugs for different paths', () => {
      const slug1 = _projectRootSlug('/home/user/project-a');
      const slug2 = _projectRootSlug('/home/user/project-b');
      expect(slug1).not.toBe(slug2);
    });
  });

  // =========================================================================
  // macOS plist generation
  // =========================================================================
  describe('generatePlist', () => {
    it('should produce valid XML with correct keys', () => {
      const plist = _generatePlist('/Users/dev/myapp', '/usr/local/bin/node', '/usr/local/lib/cli.js');

      expect(plist).toContain('<?xml version="1.0"');
      expect(plist).toContain('<key>Label</key>');
      expect(plist).toContain('com.moflo.daemon');
      expect(plist).toContain('<key>ProgramArguments</key>');
      expect(plist).toContain('/usr/local/bin/node');
      expect(plist).toContain('/usr/local/lib/cli.js');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<true/>');
      expect(plist).toContain('<key>WorkingDirectory</key>');
      expect(plist).toContain('/Users/dev/myapp');
      expect(plist).toContain('daemon');
      expect(plist).toContain('start');
      expect(plist).toContain('--foreground');
      expect(plist).toContain('--quiet');
    });

    it('should escape XML special characters in paths', () => {
      const plist = _generatePlist('/Users/dev/my&app', '/usr/bin/node', '/cli.js');
      expect(plist).toContain('my&amp;app');
      expect(plist).not.toContain('my&app');
    });
  });

  // =========================================================================
  // Linux systemd unit generation
  // =========================================================================
  describe('generateSystemdUnit', () => {
    it('should produce a valid systemd unit file', () => {
      const unit = _generateSystemdUnit('/home/dev/myapp', '/usr/bin/node', '/usr/lib/cli.js');

      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
      expect(unit).toContain('Type=simple');
      expect(unit).toContain('ExecStart="/usr/bin/node" "/usr/lib/cli.js" daemon start --foreground --quiet');
      expect(unit).toContain('WorkingDirectory=/home/dev/myapp');
      expect(unit).toContain('WantedBy=default.target');
      expect(unit).toContain('Restart=on-failure');
      expect(unit).toContain('MOFLO_DAEMON=1');
    });
  });

  // =========================================================================
  // Windows schtasks name
  // =========================================================================
  describe('schtasksName', () => {
    it('should produce a name with project slug suffix', () => {
      const name = _schtasksName('C:\\Users\\dev\\myapp');
      expect(name).toMatch(/^MoFloDaemon-/);
      expect(name.length).toBeGreaterThan('MoFloDaemon-'.length);
    });
  });

  // =========================================================================
  // isDaemonInstalled (macOS/Linux — file-based detection)
  // =========================================================================
  describe('isDaemonInstalled', () => {
    it('should return false when no service file exists (darwin)', () => {
      expect(isDaemonInstalled(tempDir, { platform: 'darwin', homeDir })).toBe(false);
    });

    it('should return false when no service file exists (linux)', () => {
      expect(isDaemonInstalled(tempDir, { platform: 'linux', homeDir })).toBe(false);
    });
  });

  // =========================================================================
  // Install and uninstall (macOS)
  // =========================================================================
  describe('install/uninstall macOS', () => {
    const darwin = (runCommand?: CommandRunner) =>
      ({ platform: 'darwin', homeDir, runCommand } as const);

    it('should write plist file on install', () => {
      const { runCommand, commands } = recordingRunner();
      const result = installDaemonService(tempDir, darwin(runCommand));

      expect(result.success).toBe(true);
      expect(result.servicePath).toBeTruthy();
      expect(result.message).toContain('installed');
      expect(result.message).toContain('login');

      // Verify file exists — and inside the injected home, not the real one
      expect(existsSync(result.servicePath!)).toBe(true);
      expect(result.servicePath!.startsWith(homeDir + sep)).toBe(true);

      // Verify content
      const content = readFileSync(result.servicePath!, 'utf-8');
      expect(content).toContain('<key>Label</key>');
      expect(content).toContain('<key>RunAtLoad</key>');

      // Install is a pure file write on macOS — no launchctl call
      expect(commands).toEqual([]);
    });

    it('should be idempotent — second install overwrites without error', () => {
      const { runCommand } = recordingRunner();
      const first = installDaemonService(tempDir, darwin(runCommand));
      expect(first.success).toBe(true);

      const second = installDaemonService(tempDir, darwin(runCommand));
      expect(second.success).toBe(true);
      expect(second.servicePath).toBe(first.servicePath);
    });

    it('should unload via launchctl and remove plist file on uninstall', () => {
      const install = recordingRunner();
      const installResult = installDaemonService(tempDir, darwin(install.runCommand));
      expect(installResult.success).toBe(true);
      expect(existsSync(installResult.servicePath!)).toBe(true);

      const uninstall = recordingRunner();
      const uninstallResult = uninstallDaemonService(tempDir, darwin(uninstall.runCommand));
      expect(uninstallResult.success).toBe(true);
      expect(uninstallResult.message).toContain('removed');
      expect(existsSync(installResult.servicePath!)).toBe(false);

      expect(uninstall.commands).toEqual([`launchctl unload "${installResult.servicePath}"`]);
    });

    it('should still remove the plist when launchctl unload fails', () => {
      const installResult = installDaemonService(tempDir, darwin(recordingRunner().runCommand));
      expect(existsSync(installResult.servicePath!)).toBe(true);

      // launchctl exits non-zero when the job was never loaded — must be swallowed
      const failing = recordingRunner(new Error('Could not find specified service'));
      const uninstallResult = uninstallDaemonService(tempDir, darwin(failing.runCommand));

      expect(uninstallResult.success).toBe(true);
      expect(existsSync(installResult.servicePath!)).toBe(false);
    });

    it('should succeed gracefully when uninstalling with no service', () => {
      const { runCommand, commands } = recordingRunner();
      const result = uninstallDaemonService(tempDir, darwin(runCommand));
      expect(result.success).toBe(true);
      expect(result.message).toContain('not installed');
      // Nothing to unload — must not shell out at all
      expect(commands).toEqual([]);
    });

    it('should detect installed service', () => {
      expect(isDaemonInstalled(tempDir, darwin())).toBe(false);

      installDaemonService(tempDir, darwin(recordingRunner().runCommand));
      expect(isDaemonInstalled(tempDir, darwin())).toBe(true);
    });
  });

  // =========================================================================
  // Install and uninstall (Linux)
  // =========================================================================
  describe('install/uninstall Linux', () => {
    const linux = (runCommand?: CommandRunner) =>
      ({ platform: 'linux', homeDir, runCommand } as const);

    it('should write systemd unit file on install', () => {
      const { runCommand } = recordingRunner();
      const result = installDaemonService(tempDir, linux(runCommand));

      expect(result.success).toBe(true);
      expect(result.servicePath).toBeTruthy();
      expect(result.message).toContain('installed');

      // Verify file exists — inside the injected home, not ~/.config
      expect(existsSync(result.servicePath!)).toBe(true);
      expect(result.servicePath!.startsWith(homeDir + sep)).toBe(true);

      // Verify content
      const content = readFileSync(result.servicePath!, 'utf-8');
      expect(content).toContain('[Unit]');
      expect(content).toContain('[Service]');
      expect(content).toContain('Type=simple');
      expect(content).toContain('WantedBy=default.target');
    });

    it('should issue daemon-reload then enable on install — and nothing else', () => {
      const { runCommand, commands } = recordingRunner();
      const result = installDaemonService(tempDir, linux(runCommand));

      expect(commands).toEqual([
        'systemctl --user daemon-reload',
        `systemctl --user enable ${basename(result.servicePath!)}`,
      ]);
    });

    it('should pass a bare unit name to systemctl, never a path', () => {
      // Regression guard for Rule #1. The unit name was derived with
      // `dest.split('/').pop()`, which returns the WHOLE path when the
      // separator is `\` — so the Linux branch built a malformed
      // `systemctl enable C:\...\unit.service` the moment it ran from a
      // Windows host. `basename` binds to the host's separator flavor and is
      // correct everywhere.
      //
      // Honest scope: on a POSIX host this assertion is near-vacuous (the path
      // it inspects has no backslash to begin with). It only bites on Windows,
      // which is why this file was added to the 3-OS leg in
      // `.github/workflows/file-sync-smoke.yml` — the ubuntu-only `Tests` job
      // cannot catch this class.
      const { runCommand, commands } = recordingRunner();
      installDaemonService(tempDir, linux(runCommand));

      const enable = commands.find((c) => c.includes('enable'))!;
      const unitArg = enable.split(' ').pop()!;
      expect(unitArg).not.toContain('/');
      expect(unitArg).not.toContain('\\');
      expect(unitArg).toMatch(/^moflo-daemon-.+\.service$/);
    });

    it('should be idempotent — second install overwrites without error', () => {
      const { runCommand } = recordingRunner();
      const first = installDaemonService(tempDir, linux(runCommand));
      expect(first.success).toBe(true);

      const second = installDaemonService(tempDir, linux(runCommand));
      expect(second.success).toBe(true);
      expect(second.servicePath).toBe(first.servicePath);
    });

    it('should remove unit file on uninstall', () => {
      const installResult = installDaemonService(tempDir, linux(recordingRunner().runCommand));
      expect(installResult.success).toBe(true);
      expect(existsSync(installResult.servicePath!)).toBe(true);

      const uninstall = recordingRunner();
      const uninstallResult = uninstallDaemonService(tempDir, linux(uninstall.runCommand));
      expect(uninstallResult.success).toBe(true);
      expect(uninstallResult.message).toContain('removed');
      expect(existsSync(installResult.servicePath!)).toBe(false);

      const unitName = basename(installResult.servicePath!);
      expect(uninstall.commands).toEqual([
        `systemctl --user disable ${unitName}`,
        `systemctl --user stop ${unitName}`,
        'systemctl --user daemon-reload',
      ]);
    });

    it('should still remove the unit file when systemctl is unavailable', () => {
      const installResult = installDaemonService(tempDir, linux(recordingRunner().runCommand));
      expect(existsSync(installResult.servicePath!)).toBe(true);

      // No systemd on this host (containers, CI) — install and uninstall must
      // both report success and leave the filesystem consistent regardless.
      const failing = recordingRunner(new Error('systemctl: command not found'));
      const uninstallResult = uninstallDaemonService(tempDir, linux(failing.runCommand));

      expect(uninstallResult.success).toBe(true);
      expect(existsSync(installResult.servicePath!)).toBe(false);
    });

    it('should report install success when systemctl is unavailable', () => {
      const failing = recordingRunner(new Error('systemctl: command not found'));
      const result = installDaemonService(tempDir, linux(failing.runCommand));

      expect(result.success).toBe(true);
      expect(existsSync(result.servicePath!)).toBe(true);
      // The first failure aborts the try block — enable is never reached
      expect(failing.commands).toEqual(['systemctl --user daemon-reload']);
    });

    it('should succeed gracefully when uninstalling with no service', () => {
      const { runCommand, commands } = recordingRunner();
      const result = uninstallDaemonService(tempDir, linux(runCommand));
      expect(result.success).toBe(true);
      expect(result.message).toContain('not installed');
      expect(commands).toEqual([]);
    });
  });

  // =========================================================================
  // Install and uninstall (Windows) — assertable from any host now that the
  // schtasks boundary is injected. Previously unreachable off Windows.
  // =========================================================================
  describe('install/uninstall Windows', () => {
    const win = (runCommand: CommandRunner) =>
      ({ platform: 'win32', homeDir, runCommand } as const);

    it('should register an ONLOGON task on install', () => {
      const { runCommand, commands } = recordingRunner();
      const result = installDaemonService(tempDir, win(runCommand));

      expect(result.success).toBe(true);
      expect(result.servicePath).toBe(_schtasksName(tempDir));
      expect(result.message).toContain('Task Scheduler');

      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('schtasks /Create');
      expect(commands[0]).toContain(`/TN "${_schtasksName(tempDir)}"`);
      expect(commands[0]).toContain('/SC ONLOGON');
      // /F makes re-registration idempotent
      expect(commands[0]).toContain('/F');
      expect(commands[0]).toContain('daemon start --foreground --quiet');
    });

    it('should report failure when schtasks rejects the create', () => {
      const failing = recordingRunner(new Error('ERROR: Access is denied.'));
      const result = installDaemonService(tempDir, win(failing.runCommand));

      expect(result.success).toBe(false);
      expect(result.servicePath).toBeNull();
      expect(result.message).toContain('Failed to create scheduled task');
      expect(result.message).toContain('Access is denied');
    });

    it('should delete the task on uninstall', () => {
      const { runCommand, commands } = recordingRunner();
      const result = uninstallDaemonService(tempDir, win(runCommand));

      expect(result.success).toBe(true);
      expect(result.message).toContain('removed');
      expect(commands).toEqual([`schtasks /Delete /TN "${_schtasksName(tempDir)}" /F`]);
    });

    it('should report not-installed when the task does not exist', () => {
      // schtasks /Delete exits non-zero for an unknown task name
      const failing = recordingRunner(new Error('ERROR: The system cannot find the file specified.'));
      const result = uninstallDaemonService(tempDir, win(failing.runCommand));

      expect(result.success).toBe(true);
      expect(result.message).toContain('not installed');
    });

    it('should detect the task via schtasks /Query', () => {
      const present = recordingRunner();
      expect(isDaemonInstalled(tempDir, win(present.runCommand))).toBe(true);
      expect(present.commands).toEqual([`schtasks /Query /TN "${_schtasksName(tempDir)}"`]);

      const absent = recordingRunner(new Error('ERROR: The system cannot find the file specified.'));
      expect(isDaemonInstalled(tempDir, win(absent.runCommand))).toBe(false);
    });
  });

  // =========================================================================
  // Path validation
  // =========================================================================
  describe('path validation', () => {
    it('should reject project roots with null bytes', () => {
      expect(() => installDaemonService('/tmp/bad\0path')).toThrow('null bytes');
    });

    it('should reject project roots with shell metacharacters', () => {
      expect(() => installDaemonService('/tmp/bad;rm -rf /')).toThrow('shell metacharacters');
      expect(() => installDaemonService('/tmp/bad|path')).toThrow('shell metacharacters');
      expect(() => installDaemonService('/tmp/bad&path')).toThrow('shell metacharacters');
    });
  });

  // =========================================================================
  // Unsupported platform
  // =========================================================================
  describe('unsupported platform', () => {
    it('should return failure for unknown platforms', () => {
      const { runCommand, commands } = recordingRunner();
      const options = { platform: 'freebsd', homeDir, runCommand } as const;

      const result = installDaemonService(tempDir, options);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported platform');

      const uninstallResult = uninstallDaemonService(tempDir, options);
      expect(uninstallResult.success).toBe(false);
      expect(commands).toEqual([]);
    });

    it('should return false for isDaemonInstalled on unknown platform', () => {
      expect(isDaemonInstalled(tempDir, { platform: 'freebsd', homeDir })).toBe(false);
    });
  });
});
