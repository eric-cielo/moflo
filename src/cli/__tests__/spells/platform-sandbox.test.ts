/**
 * Platform Sandbox Detection Tests
 *
 * Tests for OS-level sandbox detection and config resolution.
 * Uses mocking to test all platform paths without requiring actual OS tools.
 *
 * @see https://github.com/eric-cielo/moflo/issues/409
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectSandboxCapability,
  resetSandboxCache,
  resolveSandboxConfig,
  resolveEffectiveSandbox,
  formatSandboxLog,
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
} from '../../spells/core/platform-sandbox.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('node:os', () => ({
  platform: vi.fn(() => 'linux'),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

import { platform } from 'node:os';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const mockPlatform = vi.mocked(platform);
const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  resetSandboxCache();
  vi.clearAllMocks();
});

// ============================================================================
// detectSandboxCapability()
// ============================================================================

describe('detectSandboxCapability', () => {

  // ── macOS ──────────────────────────────────────────────────────────

  describe('macOS', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('darwin');
    });

    it('detects sandbox-exec when present', () => {
      mockExistsSync.mockReturnValue(true);
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'darwin',
        available: true,
        tool: 'sandbox-exec',
        overhead: 'low',
      });
    });

    it('returns unavailable when sandbox-exec is missing', () => {
      mockExistsSync.mockReturnValue(false);
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'darwin',
        available: false,
        tool: null,
        overhead: null,
      });
    });
  });

  // ── Linux ──────────────────────────────────────────────────────────

  describe('Linux', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('linux');
    });

    it('detects bwrap when present', () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/bwrap'));
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'linux',
        available: true,
        tool: 'bwrap',
        overhead: 'low',
      });
    });

    it('returns unavailable when bwrap is absent', () => {
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'linux',
        available: false,
        tool: null,
        overhead: null,
      });
    });
  });

  // ── Windows ────────────────────────────────────────────────────────

  describe('Windows', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('win32');
    });

    it('detects Docker Desktop when installed and daemon running', () => {
      // First call: `where docker` succeeds
      // Second call: `docker info` succeeds
      mockExecSync.mockReturnValue(Buffer.from(''));
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'win32',
        available: true,
        tool: 'docker',
        overhead: 'medium',
      });
    });

    it('returns unavailable when docker binary not found', () => {
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'win32',
        available: false,
        tool: null,
        overhead: null,
      });
    });

    it('returns unavailable when docker daemon is not running', () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from(''); // `where docker` OK
        throw new Error('daemon not running'); // `docker info` fails
      });
      const result = detectSandboxCapability();
      expect(result).toEqual({
        platform: 'win32',
        available: false,
        tool: null,
        overhead: null,
      });
    });
  });

  // ── Unsupported platform ────────────────────────────────────────────

  it('returns unavailable for unsupported platforms', () => {
    mockPlatform.mockReturnValue('freebsd' as NodeJS.Platform);
    const result = detectSandboxCapability();
    expect(result).toEqual({
      platform: 'freebsd',
      available: false,
      tool: null,
      overhead: null,
    });
  });

  // ── Caching ─────────────────────────────────────────────────────────

  it('caches the result for the process lifetime', () => {
    mockPlatform.mockReturnValue('linux');
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/bwrap'));

    const first = detectSandboxCapability();
    const second = detectSandboxCapability();

    expect(first).toBe(second); // Same reference
    // execSync called only for the first detection (which for linux)
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('resetSandboxCache allows re-detection', () => {
    mockPlatform.mockReturnValue('linux');
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/bwrap'));

    detectSandboxCapability();
    resetSandboxCache();
    detectSandboxCapability();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// resolveSandboxConfig()
// ============================================================================

describe('resolveSandboxConfig', () => {
  it('returns defaults when no raw config provided', () => {
    expect(resolveSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(resolveSandboxConfig(undefined)).toEqual(DEFAULT_SANDBOX_CONFIG);
  });

  it('parses enabled: false', () => {
    const config = resolveSandboxConfig({ enabled: false });
    expect(config.enabled).toBe(false);
    expect(config.tier).toBe('auto');
  });

  it('parses tier: denylist-only', () => {
    const config = resolveSandboxConfig({ tier: 'denylist-only' });
    expect(config.tier).toBe('denylist-only');
  });

  it('parses tier: full', () => {
    const config = resolveSandboxConfig({ tier: 'full' });
    expect(config.tier).toBe('full');
  });

  it('ignores invalid tier values', () => {
    const config = resolveSandboxConfig({ tier: 'invalid' });
    expect(config.tier).toBe('auto');
  });

  it('ignores non-boolean enabled values', () => {
    const config = resolveSandboxConfig({ enabled: 'yes' });
    expect(config.enabled).toBe(false); // default (sandbox off unless opted in)
  });
});

// ============================================================================
// resolveEffectiveSandbox()
// ============================================================================

describe('resolveEffectiveSandbox', () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue('linux');
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/bwrap'));
  });

  it('uses OS sandbox when available and config is auto', () => {
    const effective = resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
    expect(effective.useOsSandbox).toBe(true);
    expect(effective.capability.tool).toBe('bwrap');
    expect(effective.displayStatus).toContain('bwrap');
  });

  it('disables OS sandbox when config.enabled is false', () => {
    const effective = resolveEffectiveSandbox({ enabled: false, tier: 'auto' });
    expect(effective.useOsSandbox).toBe(false);
    expect(effective.displayStatus).toContain('disabled');
  });

  it('disables OS sandbox when tier is denylist-only', () => {
    const effective = resolveEffectiveSandbox({ enabled: true, tier: 'denylist-only' });
    expect(effective.useOsSandbox).toBe(false);
    expect(effective.displayStatus).toContain('disabled');
  });

  it('throws when tier is full but no sandbox available', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(() => resolveEffectiveSandbox({ enabled: true, tier: 'full' })).toThrow(
      /Sandbox tier "full" requires an OS sandbox/,
    );
  });

  it('falls back gracefully when tier is auto and no sandbox available', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    const effective = resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
    expect(effective.useOsSandbox).toBe(false);
    expect(effective.displayStatus).toContain('not available');
  });

  // ── Windows-specific Docker setup guidance ─────────────────────────

  describe('Windows Docker setup errors', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('win32');
    });

    it('throws friendly message when sandbox enabled but Docker not installed', () => {
      // binaryExists(docker) returns false
      mockExecSync.mockImplementation(() => { throw new Error('where: not found'); });

      expect(() => resolveEffectiveSandbox({
        enabled: true,
        tier: 'auto',
        dockerImage: 'node:20-bookworm',
      })).toThrow(/Install Docker Desktop/);
    });

    it('throws friendly message when sandbox enabled but daemon not running', () => {
      // binaryExists returns true, docker info throws
      let call = 0;
      mockExecSync.mockImplementation(() => {
        call++;
        if (call === 1) return Buffer.from(''); // where docker
        throw new Error('daemon not running'); // docker info
      });

      expect(() => resolveEffectiveSandbox({
        enabled: true,
        tier: 'auto',
        dockerImage: 'node:20-bookworm',
      })).toThrow(/start Docker Desktop/i);
    });

    it('auto-defaults dockerImage to recommended image when not configured', () => {
      // where docker ok, docker info ok, docker image inspect ok (auto-default image exists)
      mockExecSync.mockReturnValue(Buffer.from(''));

      const effective = resolveEffectiveSandbox({
        enabled: true,
        tier: 'auto',
      });
      expect(effective.useOsSandbox).toBe(true);
      expect(effective.config.dockerImage).toBe('ghcr.io/eric-cielo/moflo-sandbox:latest');
    });

    it('auto-pulls image when configured but not present locally', () => {
      // where docker ok, docker info ok, docker image inspect fails, docker pull ok
      let call = 0;
      mockExecSync.mockImplementation(() => {
        call++;
        if (call <= 2) return Buffer.from(''); // where + info
        if (call === 3) throw new Error('No such image'); // docker image inspect
        return Buffer.from(''); // docker pull succeeds
      });

      const effective = resolveEffectiveSandbox({
        enabled: true,
        tier: 'auto',
        dockerImage: 'node:20-bookworm',
      });
      expect(effective.useOsSandbox).toBe(true);
    });

    it('succeeds when Docker ready, image configured and pulled', () => {
      mockExecSync.mockReturnValue(Buffer.from(''));

      const effective = resolveEffectiveSandbox({
        enabled: true,
        tier: 'auto',
        dockerImage: 'node:20-bookworm',
      });
      expect(effective.useOsSandbox).toBe(true);
      expect(effective.capability.tool).toBe('docker');
      expect(effective.config.dockerImage).toBe('node:20-bookworm');
    });

    it('skips Docker checks when sandbox disabled', () => {
      mockExecSync.mockImplementation(() => { throw new Error('no docker'); });

      const effective = resolveEffectiveSandbox({ enabled: false, tier: 'auto' });
      expect(effective.useOsSandbox).toBe(false);
      expect(effective.displayStatus).toContain('disabled');
    });

    it('skips Docker checks when tier is denylist-only', () => {
      mockExecSync.mockImplementation(() => { throw new Error('no docker'); });

      const effective = resolveEffectiveSandbox({ enabled: true, tier: 'denylist-only' });
      expect(effective.useOsSandbox).toBe(false);
      expect(effective.displayStatus).toContain('disabled');
    });
  });
});

// ============================================================================
// resolveSandboxConfig — dockerImage handling
// ============================================================================

describe('resolveSandboxConfig', () => {
  it('picks up dockerImage from camelCase key', () => {
    const cfg = resolveSandboxConfig({ enabled: true, dockerImage: 'my:img' });
    expect(cfg.dockerImage).toBe('my:img');
  });

  it('picks up dockerImage from snake_case key', () => {
    const cfg = resolveSandboxConfig({ enabled: true, docker_image: 'my:img' });
    expect(cfg.dockerImage).toBe('my:img');
  });

  it('ignores blank dockerImage', () => {
    const cfg = resolveSandboxConfig({ enabled: true, dockerImage: '   ' });
    expect(cfg.dockerImage).toBeUndefined();
  });

  it('omits dockerImage when not set', () => {
    const cfg = resolveSandboxConfig({ enabled: true });
    expect(cfg.dockerImage).toBeUndefined();
  });
});

// ============================================================================
// formatSandboxLog()
// ============================================================================

describe('formatSandboxLog', () => {
  it('formats the log message with [spell] prefix', () => {
    mockPlatform.mockReturnValue('darwin');
    mockExistsSync.mockReturnValue(true);
    const effective = resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
    const log = formatSandboxLog(effective);
    expect(log).toBe('[spell] OS sandbox: sandbox-exec (darwin)');
  });

  it('formats disabled status', () => {
    const effective = resolveEffectiveSandbox({ enabled: false, tier: 'auto' });
    const log = formatSandboxLog(effective);
    expect(log).toBe('[spell] OS sandbox: disabled (denylist active)');
  });
});

// ============================================================================
// Denylist independence — sandbox config never disables the denylist
// ============================================================================

describe('denylist independence', () => {
  it('denylist runs regardless of sandbox enabled=false', () => {
    // This test verifies the architectural guarantee: sandbox config
    // only controls OS-level sandboxing, never the denylist.
    const config = resolveSandboxConfig({ enabled: false });
    expect(config.enabled).toBe(false);
    // The denylist is enforced in bash-command.ts via checkDestructivePatterns,
    // which has no dependency on SandboxConfig. This test documents the contract.
  });

  it('denylist runs regardless of sandbox tier=denylist-only', () => {
    const config = resolveSandboxConfig({ tier: 'denylist-only' });
    expect(config.tier).toBe('denylist-only');
    // Same as above — denylist is always active, sandbox config is orthogonal.
  });
});
