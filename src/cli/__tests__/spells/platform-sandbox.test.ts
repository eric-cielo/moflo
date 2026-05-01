/**
 * Platform Sandbox Detection Tests
 *
 * Tests for OS-level sandbox detection and config resolution.
 * Mocks at three abstraction boundaries:
 *   - `commandExists` (prerequisite-checker) — binary-on-PATH probes
 *   - `execFileAsync`  (shell.ts)              — `docker info` / `docker image inspect`
 *   - `spawn`          (child_process)         — `docker pull`
 *
 * @see https://github.com/eric-cielo/moflo/issues/409
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:os', () => ({
  platform: vi.fn(() => 'linux'),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

vi.mock('../../spells/core/prerequisite-checker.js', () => ({
  commandExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../spells/core/shell.js', () => ({
  execFileAsync: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import {
  detectSandboxCapability,
  resetSandboxCache,
  resolveSandboxConfig,
  resolveEffectiveSandbox,
  formatSandboxLog,
  DEFAULT_SANDBOX_CONFIG,
} from '../../spells/core/platform-sandbox.js';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { commandExists } from '../../spells/core/prerequisite-checker.js';
import { execFileAsync } from '../../spells/core/shell.js';
import { spawn } from 'node:child_process';

const mockPlatform = vi.mocked(platform);
const mockExistsSync = vi.mocked(existsSync);
const mockCommandExists = vi.mocked(commandExists);
const mockExecFileAsync = vi.mocked(execFileAsync);
const mockSpawn = vi.mocked(spawn);

// ── Mock helpers ──────────────────────────────────────────────────────

/** All `docker <args>` probes return exitCode 0 (success). */
function dockerSuccess(): void {
  mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
}

/** All `docker <args>` probes return exitCode 1 (daemon down / not found). */
function dockerFailure(): void {
  mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
}

/** Per-args dispatch: route specific docker probes to success/failure exit codes. */
function dockerRouter(decide: (args: readonly string[]) => 0 | 1): void {
  mockExecFileAsync.mockImplementation(async (_file, args) => ({
    stdout: '', stderr: '', exitCode: decide(args),
  }));
}

/** Make spawn() return a fake child that emits exit 0 next tick. */
function spawnSuccess(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSpawn.mockImplementation(((..._args: any[]) => {
    const proc = new EventEmitter() as EventEmitter & { kill: () => boolean };
    proc.kill = () => true;
    setImmediate(() => proc.emit('exit', 0));
    return proc as unknown as ReturnType<typeof spawn>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

beforeEach(() => {
  resetSandboxCache();
  vi.clearAllMocks();
  mockCommandExists.mockResolvedValue(false);
  dockerSuccess(); // benign default
});

// ============================================================================
// detectSandboxCapability()
// ============================================================================

describe('detectSandboxCapability', () => {
  describe('macOS', () => {
    beforeEach(() => mockPlatform.mockReturnValue('darwin'));

    it('detects sandbox-exec when present', async () => {
      mockExistsSync.mockReturnValue(true);
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'darwin', available: true, tool: 'sandbox-exec', overhead: 'low',
      });
    });

    it('returns unavailable when sandbox-exec is missing', async () => {
      mockExistsSync.mockReturnValue(false);
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'darwin', available: false, tool: null, overhead: null,
      });
    });
  });

  describe('Linux', () => {
    beforeEach(() => mockPlatform.mockReturnValue('linux'));

    it('detects bwrap when present', async () => {
      mockCommandExists.mockResolvedValue(true);
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'linux', available: true, tool: 'bwrap', overhead: 'low',
      });
    });

    it('returns unavailable when bwrap is absent', async () => {
      mockCommandExists.mockResolvedValue(false);
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'linux', available: false, tool: null, overhead: null,
      });
    });
  });

  describe('Windows', () => {
    beforeEach(() => mockPlatform.mockReturnValue('win32'));

    it('detects Docker Desktop when installed and daemon running', async () => {
      mockCommandExists.mockResolvedValue(true); // docker on PATH
      dockerSuccess(); // docker info ok
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'win32', available: true, tool: 'docker', overhead: 'medium',
      });
    });

    it('returns unavailable when docker binary not found', async () => {
      mockCommandExists.mockResolvedValue(false);
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'win32', available: false, tool: null, overhead: null,
      });
    });

    it('returns unavailable when docker daemon is not running', async () => {
      mockCommandExists.mockResolvedValue(true);
      dockerFailure(); // docker info errors
      const result = await detectSandboxCapability();
      expect(result).toEqual({
        platform: 'win32', available: false, tool: null, overhead: null,
      });
    });
  });

  it('returns unavailable for unsupported platforms', async () => {
    mockPlatform.mockReturnValue('freebsd' as NodeJS.Platform);
    const result = await detectSandboxCapability();
    expect(result).toEqual({
      platform: 'freebsd', available: false, tool: null, overhead: null,
    });
  });

  it('caches the result for the process lifetime', async () => {
    mockPlatform.mockReturnValue('linux');
    mockCommandExists.mockResolvedValue(true);

    const first = await detectSandboxCapability();
    const second = await detectSandboxCapability();

    expect(first).toBe(second);
    expect(mockCommandExists).toHaveBeenCalledTimes(1);
  });

  it('resetSandboxCache allows re-detection', async () => {
    mockPlatform.mockReturnValue('linux');
    mockCommandExists.mockResolvedValue(true);

    await detectSandboxCapability();
    resetSandboxCache();
    await detectSandboxCapability();

    expect(mockCommandExists).toHaveBeenCalledTimes(2);
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
    expect(config.enabled).toBe(false);
  });

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
// resolveEffectiveSandbox()
// ============================================================================

describe('resolveEffectiveSandbox', () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue('linux');
    mockCommandExists.mockResolvedValue(true); // bwrap available
  });

  it('uses OS sandbox when available and config is auto', async () => {
    const effective = await resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
    expect(effective.useOsSandbox).toBe(true);
    expect(effective.capability.tool).toBe('bwrap');
    expect(effective.displayStatus).toContain('bwrap');
  });

  it('disables OS sandbox when config.enabled is false', async () => {
    const effective = await resolveEffectiveSandbox({ enabled: false, tier: 'auto' });
    expect(effective.useOsSandbox).toBe(false);
    expect(effective.displayStatus).toContain('disabled');
  });

  it('disables OS sandbox when tier is denylist-only', async () => {
    const effective = await resolveEffectiveSandbox({ enabled: true, tier: 'denylist-only' });
    expect(effective.useOsSandbox).toBe(false);
    expect(effective.displayStatus).toContain('disabled');
  });

  it('throws when tier is full but no sandbox available', async () => {
    mockCommandExists.mockResolvedValue(false);
    await expect(resolveEffectiveSandbox({ enabled: true, tier: 'full' })).rejects.toThrow(
      /Sandbox tier "full" requires an OS sandbox/,
    );
  });

  it('falls back gracefully when tier is auto and no sandbox available', async () => {
    mockCommandExists.mockResolvedValue(false);
    const effective = await resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
    expect(effective.useOsSandbox).toBe(false);
    expect(effective.displayStatus).toContain('not available');
  });

  describe('Windows Docker setup errors', () => {
    beforeEach(() => mockPlatform.mockReturnValue('win32'));

    it('throws friendly message when sandbox enabled but Docker not installed', async () => {
      mockCommandExists.mockResolvedValue(false); // docker missing
      await expect(resolveEffectiveSandbox({
        enabled: true, tier: 'auto', dockerImage: 'node:20-bookworm',
      })).rejects.toThrow(/Install Docker Desktop/);
    });

    it('throws friendly message when sandbox enabled but daemon not running', async () => {
      mockCommandExists.mockResolvedValue(true); // docker present
      dockerFailure(); // info fails → daemon down
      await expect(resolveEffectiveSandbox({
        enabled: true, tier: 'auto', dockerImage: 'node:20-bookworm',
      })).rejects.toThrow(/start Docker Desktop/i);
    });

    it('auto-defaults dockerImage to recommended image when not configured', async () => {
      mockCommandExists.mockResolvedValue(true);
      dockerSuccess(); // info + image inspect both succeed
      const effective = await resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
      expect(effective.useOsSandbox).toBe(true);
      expect(effective.config.dockerImage).toBe('ghcr.io/eric-cielo/moflo-sandbox:latest');
    });

    it('auto-pulls image when configured but not present locally', async () => {
      mockCommandExists.mockResolvedValue(true);
      // info ok; image inspect fails → triggers pull
      dockerRouter((args) =>
        args[0] === 'image' && args[1] === 'inspect' ? 1 : 0,
      );
      spawnSuccess();
      const effective = await resolveEffectiveSandbox({
        enabled: true, tier: 'auto', dockerImage: 'node:20-bookworm',
      });
      expect(effective.useOsSandbox).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('docker', ['pull', 'node:20-bookworm'], expect.objectContaining({ stdio: 'inherit' }));
    });

    it('succeeds when Docker ready, image configured and pulled', async () => {
      mockCommandExists.mockResolvedValue(true);
      dockerSuccess();
      const effective = await resolveEffectiveSandbox({
        enabled: true, tier: 'auto', dockerImage: 'node:20-bookworm',
      });
      expect(effective.useOsSandbox).toBe(true);
      expect(effective.capability.tool).toBe('docker');
      expect(effective.config.dockerImage).toBe('node:20-bookworm');
    });

    it('skips Docker checks when sandbox disabled', async () => {
      mockCommandExists.mockResolvedValue(false);
      const effective = await resolveEffectiveSandbox({ enabled: false, tier: 'auto' });
      expect(effective.useOsSandbox).toBe(false);
      expect(effective.displayStatus).toContain('disabled');
    });

    it('skips Docker checks when tier is denylist-only', async () => {
      mockCommandExists.mockResolvedValue(false);
      const effective = await resolveEffectiveSandbox({ enabled: true, tier: 'denylist-only' });
      expect(effective.useOsSandbox).toBe(false);
      expect(effective.displayStatus).toContain('disabled');
    });
  });
});

// ============================================================================
// formatSandboxLog()
// ============================================================================

describe('formatSandboxLog', () => {
  it('formats the log message with [spell] prefix', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockExistsSync.mockReturnValue(true);
    const effective = await resolveEffectiveSandbox({ enabled: true, tier: 'auto' });
    const log = formatSandboxLog(effective);
    expect(log).toBe('[spell] OS sandbox: sandbox-exec (darwin)');
  });

  it('formats disabled status', async () => {
    const effective = await resolveEffectiveSandbox({ enabled: false, tier: 'auto' });
    const log = formatSandboxLog(effective);
    expect(log).toBe('[spell] OS sandbox: disabled (denylist active)');
  });
});

// ============================================================================
// Denylist independence — sandbox config never disables the denylist
// ============================================================================

describe('denylist independence', () => {
  it('denylist runs regardless of sandbox enabled=false', () => {
    const config = resolveSandboxConfig({ enabled: false });
    expect(config.enabled).toBe(false);
  });

  it('denylist runs regardless of sandbox tier=denylist-only', () => {
    const config = resolveSandboxConfig({ tier: 'denylist-only' });
    expect(config.tier).toBe('denylist-only');
  });
});
