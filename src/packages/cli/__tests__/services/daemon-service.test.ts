/**
 * Daemon Service Tests
 *
 * Validates OS-native service installation/uninstallation
 * for macOS (launchd), Linux (systemd), and Windows (schtasks).
 *
 * Uses real temp directories with platform mocking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import internals for testing
import {
  isDaemonInstalled,
  installDaemonService,
  uninstallDaemonService,
  _generatePlist,
  _generateSystemdUnit,
  _plistPath,
  _systemdUnitPath,
  _schtasksName,
  _projectRootSlug,
} from '../../src/services/daemon-service.js';

describe('daemon-service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'daemon-service-test-'));
    mkdirSync(join(tempDir, '.claude-flow'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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
      expect(unit).toContain('CLAUDE_FLOW_DAEMON=1');
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
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

      try {
        expect(isDaemonInstalled(tempDir)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
      }
    });

    it('should return false when no service file exists (linux)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      try {
        expect(isDaemonInstalled(tempDir)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
      }
    });
  });

  // =========================================================================
  // Install and uninstall (macOS)
  // =========================================================================
  describe('install/uninstall macOS', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    });

    it('should write plist file on install', () => {
      const result = installDaemonService(tempDir);

      expect(result.success).toBe(true);
      expect(result.servicePath).toBeTruthy();
      expect(result.message).toContain('installed');
      expect(result.message).toContain('login');

      // Verify file exists
      expect(existsSync(result.servicePath!)).toBe(true);

      // Verify content
      const content = readFileSync(result.servicePath!, 'utf-8');
      expect(content).toContain('<key>Label</key>');
      expect(content).toContain('<key>RunAtLoad</key>');
    });

    it('should be idempotent — second install overwrites without error', () => {
      const first = installDaemonService(tempDir);
      expect(first.success).toBe(true);

      const second = installDaemonService(tempDir);
      expect(second.success).toBe(true);
      expect(second.servicePath).toBe(first.servicePath);
    });

    it('should remove plist file on uninstall', () => {
      // Install first
      const installResult = installDaemonService(tempDir);
      expect(installResult.success).toBe(true);
      expect(existsSync(installResult.servicePath!)).toBe(true);

      // launchctl unload will fail in tests (not a real plist) but the try/catch handles it
      const uninstallResult = uninstallDaemonService(tempDir);
      expect(uninstallResult.success).toBe(true);
      expect(uninstallResult.message).toContain('removed');
      expect(existsSync(installResult.servicePath!)).toBe(false);
    });

    it('should succeed gracefully when uninstalling with no service', () => {
      const result = uninstallDaemonService(tempDir);
      expect(result.success).toBe(true);
      expect(result.message).toContain('not installed');
    });

    it('should detect installed service', () => {
      expect(isDaemonInstalled(tempDir)).toBe(false);

      installDaemonService(tempDir);
      expect(isDaemonInstalled(tempDir)).toBe(true);
    });
  });

  // =========================================================================
  // Install and uninstall (Linux)
  // =========================================================================
  describe('install/uninstall Linux', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      // systemctl calls will fail in tests but the try/catch handles it
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    });

    it('should write systemd unit file on install', () => {
      const result = installDaemonService(tempDir);

      expect(result.success).toBe(true);
      expect(result.servicePath).toBeTruthy();
      expect(result.message).toContain('installed');

      // Verify file exists
      expect(existsSync(result.servicePath!)).toBe(true);

      // Verify content
      const content = readFileSync(result.servicePath!, 'utf-8');
      expect(content).toContain('[Unit]');
      expect(content).toContain('[Service]');
      expect(content).toContain('Type=simple');
      expect(content).toContain('WantedBy=default.target');
    });

    it('should be idempotent — second install overwrites without error', () => {
      const first = installDaemonService(tempDir);
      expect(first.success).toBe(true);

      const second = installDaemonService(tempDir);
      expect(second.success).toBe(true);
    });

    it('should remove unit file on uninstall', () => {
      const installResult = installDaemonService(tempDir);
      expect(installResult.success).toBe(true);
      expect(existsSync(installResult.servicePath!)).toBe(true);

      const uninstallResult = uninstallDaemonService(tempDir);
      expect(uninstallResult.success).toBe(true);
      expect(uninstallResult.message).toContain('removed');
      expect(existsSync(installResult.servicePath!)).toBe(false);
    });

    it('should succeed gracefully when uninstalling with no service', () => {
      const result = uninstallDaemonService(tempDir);
      expect(result.success).toBe(true);
      expect(result.message).toContain('not installed');
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
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'freebsd', writable: true });

      try {
        const result = installDaemonService(tempDir);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Unsupported platform');

        const uninstallResult = uninstallDaemonService(tempDir);
        expect(uninstallResult.success).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
      }
    });

    it('should return false for isDaemonInstalled on unknown platform', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'freebsd', writable: true });

      try {
        expect(isDaemonInstalled(tempDir)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
      }
    });
  });
});
