/**
 * Bash Command — Bubblewrap (bwrap) Integration Tests
 *
 * Tests that the bash step command correctly integrates with bwrap
 * wrapping when sandbox is enabled on Linux.
 *
 * @see https://github.com/eric-cielo/moflo/issues/411
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be before imports that use mocked modules)
// ============================================================================

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('node:os', () => ({
  platform: vi.fn(() => 'linux'),
  tmpdir: vi.fn(() => '/tmp'),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'testprofile12345' })),
}));

vi.mock('../core/interpolation.js', () => ({
  shellInterpolateString: (s: string) => s,
  interpolateConfig: (c: unknown) => c,
}));

vi.mock('../core/capability-validator.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkCapabilities: () => ({ allowed: true, effectiveCaps: [], violations: [] }),
    enforceScope: () => null,
    formatViolations: (v: unknown[]) => Array.isArray(v) ? v.join(', ') : String(v),
  };
});

vi.mock('../core/permission-resolver.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolvePermissions: () => ({ cliArgs: [] }),
  };
});

vi.mock('../commands/destructive-pattern-checker.js', () => ({
  checkDestructivePatterns: () => null,
  formatDestructiveError: (m: unknown) => String(m),
}));

import { bashCommand, type BashStepConfig } from '../../spells/commands/bash-command.js';
import { createMockProcess, makeSandbox, makeContext } from './helpers/bash-test-utils.js';

// ============================================================================
// Tests
// ============================================================================

describe('bash command bwrap integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns with bwrap when sandbox is enabled on Linux', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/home/user/project', makeSandbox(true, 'linux', 'bwrap'));

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe('bwrap');
    expect(args).toContain('--ro-bind');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-net');
    const bashIdx = args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(-1);
    expect(args[bashIdx + 1]).toBe('-c');
    expect(args[bashIdx + 2]).toBe('echo hello');
    expect(result.success).toBe(true);
  });

  it('spawns bash directly when sandbox is not enabled', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/home/user/project', makeSandbox(false, 'linux', 'bwrap'));

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).not.toBe('bwrap');
    expect(args).toEqual(['-c', 'echo hello']);
    expect(result.success).toBe(true);
  });

  it('spawns bash directly when no sandbox context provided', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/home/user/project');

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    const [bin] = mockSpawn.mock.calls[0];
    expect(bin).not.toBe('bwrap');
    expect(result.success).toBe(true);
  });

  it('falls back to unsandboxed when bwrap spawn fails', async () => {
    const failProc = createMockProcess();
    const fallbackProc = createMockProcess();

    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return failProc;
      return fallbackProc;
    });

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/home/user/project', makeSandbox(true, 'linux', 'bwrap'));

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      failProc.emit('error', err);
    }, 10);

    setTimeout(() => {
      fallbackProc.stdout.emit('data', Buffer.from('hello\n'));
      fallbackProc.emit('close', 0, null);
    }, 30);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.data.stdout).toBe('hello');
  });
});
