/**
 * Bash Command — Sandbox-exec Integration Tests
 *
 * Tests that the bash step command correctly integrates with sandbox-exec
 * wrapping when sandbox is enabled on macOS.
 *
 * @see https://github.com/eric-cielo/moflo/issues/410
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('node:os', () => ({
  platform: vi.fn(() => 'darwin'),
  tmpdir: vi.fn(() => '/private/tmp'),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'testprofile12345' })),
}));

vi.mock('../src/core/interpolation.js', () => ({
  shellInterpolateString: (s: string) => s,
  interpolateConfig: (c: unknown) => c,
}));

vi.mock('../src/core/capability-validator.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkCapabilities: () => ({ allowed: true, effectiveCaps: [], violations: [] }),
    enforceScope: () => null,
    formatViolations: (v: unknown[]) => Array.isArray(v) ? v.join(', ') : String(v),
  };
});

vi.mock('../src/core/permission-resolver.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolvePermissions: () => ({ cliArgs: [] }),
  };
});

vi.mock('../src/commands/destructive-pattern-checker.js', () => ({
  checkDestructivePatterns: () => null,
  formatDestructiveError: (m: unknown) => String(m),
}));

import { bashCommand, type BashStepConfig } from '../../src/spells/commands/bash-command.js';
import { createMockProcess, makeSandbox, makeContext } from './helpers/bash-test-utils.js';

// ============================================================================
// Tests
// ============================================================================

describe('bash command sandbox-exec integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns with sandbox-exec when sandbox is enabled on macOS', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/Users/dev/project', makeSandbox(true, 'darwin', 'sandbox-exec'));

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe('/usr/bin/sandbox-exec');
    expect(args[0]).toBe('-f');
    expect(args[1]).toMatch(/moflo-sandbox-.*\.sb$/);
    expect(args[2]).toBe('bash');
    expect(args[3]).toBe('-c');
    expect(args[4]).toBe('echo hello');
    expect(result.success).toBe(true);
  });

  it('spawns bash directly when sandbox is not enabled', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/Users/dev/project', makeSandbox(false, 'darwin', 'sandbox-exec'));

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).not.toBe('/usr/bin/sandbox-exec');
    expect(args).toEqual(['-c', 'echo hello']);
    expect(result.success).toBe(true);
  });

  it('spawns bash directly when no sandbox context provided', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/Users/dev/project');

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    const [bin] = mockSpawn.mock.calls[0];
    expect(bin).not.toBe('/usr/bin/sandbox-exec');
    expect(result.success).toBe(true);
  });

  it('falls back to unsandboxed when sandbox-exec spawn fails', async () => {
    const failProc = createMockProcess();
    const fallbackProc = createMockProcess();

    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return failProc;
      return fallbackProc;
    });

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext('/Users/dev/project', makeSandbox(true, 'darwin', 'sandbox-exec'));

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
