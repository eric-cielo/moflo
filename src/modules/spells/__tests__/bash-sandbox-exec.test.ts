/**
 * Bash Command — Sandbox-exec Integration Tests
 *
 * Tests that the bash step command correctly integrates with sandbox-exec
 * wrapping when sandbox is enabled on macOS.
 *
 * @see https://github.com/eric-cielo/moflo/issues/410
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CastingContext, StepCapability } from '../src/types/step-command.types.js';
import type { EffectiveSandbox, SandboxCapability, SandboxConfig } from '../src/core/platform-sandbox.js';
import { DENY_ALL_GATEWAY, CapabilityGateway } from '../src/core/capability-gateway.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock child_process to intercept spawn calls
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock platform
vi.mock('node:os', () => ({
  platform: vi.fn(() => 'darwin'),
  tmpdir: vi.fn(() => '/private/tmp'),
}));

// Mock fs for sandbox-profile.ts
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'testprofile12345' })),
}));

// Mock the interpolation module to pass commands through
vi.mock('../src/core/interpolation.js', () => ({
  shellInterpolateString: (s: string) => s,
  interpolateConfig: (c: unknown) => c,
}));

// Mock the capability validator — keep real exports, override functions
vi.mock('../src/core/capability-validator.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkCapabilities: () => ({ allowed: true, effectiveCaps: [], violations: [] }),
    enforceScope: () => null,
    formatViolations: (v: unknown[]) => Array.isArray(v) ? v.join(', ') : String(v),
  };
});

// Mock permission resolver
vi.mock('../src/core/permission-resolver.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolvePermissions: () => ({ cliArgs: [] }),
  };
});

// Mock destructive pattern checker
vi.mock('../src/commands/destructive-pattern-checker.js', () => ({
  checkDestructivePatterns: () => null,
  formatDestructiveError: (m: unknown) => String(m),
}));

import { bashCommand, type BashStepConfig } from '../src/commands/bash-command.js';
import { EventEmitter } from 'node:events';

// ============================================================================
// Helpers
// ============================================================================

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.pid = 12345;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  // Need destroy methods for cleanup
  (proc.stdout as EventEmitter & { destroy: () => void }).destroy = vi.fn();
  (proc.stderr as EventEmitter & { destroy: () => void }).destroy = vi.fn();

  return proc;
}

function makeSandbox(useOsSandbox: boolean): EffectiveSandbox {
  const capability: SandboxCapability = {
    platform: 'darwin',
    available: useOsSandbox,
    tool: useOsSandbox ? 'sandbox-exec' : null,
    overhead: useOsSandbox ? 'low' : null,
  };
  const config: SandboxConfig = { enabled: true, tier: 'auto' };
  return {
    useOsSandbox,
    capability,
    config,
    displayStatus: useOsSandbox ? 'OS sandbox: sandbox-exec (darwin)' : 'OS sandbox: disabled',
  };
}

const CAPS: StepCapability[] = [
  { type: 'shell' },
  { type: 'fs:read' },
];

function makeContext(sandbox?: EffectiveSandbox): CastingContext {
  const gateway = new CapabilityGateway(CAPS, 'test-step-0', 'bash');
  return {
    variables: { projectRoot: '/Users/dev/project' },
    args: {},
    credentials: { get: async () => undefined },
    memory: {
      get: async () => undefined,
      set: async () => {},
      search: async () => [],
    },
    taskId: 'test-step-0',
    spellId: 'test-spell',
    stepIndex: 0,
    effectiveCaps: CAPS,
    gateway,
    sandbox,
  };
}

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
    const context = makeContext(makeSandbox(true));

    const promise = bashCommand.execute(config, context);

    // Emit close to resolve the promise
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    // Should have spawned sandbox-exec, not bash directly
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
    const context = makeContext(makeSandbox(false));

    const promise = bashCommand.execute(config, context);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('hello\n'));
      proc.emit('close', 0, null);
    }, 10);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockSpawn.mock.calls[0];
    // Should NOT be sandbox-exec
    expect(bin).not.toBe('/usr/bin/sandbox-exec');
    expect(args).toEqual(['-c', 'echo hello']);
    expect(result.success).toBe(true);
  });

  it('spawns bash directly when no sandbox context provided', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const config: BashStepConfig = { command: 'echo hello' };
    const context = makeContext(); // no sandbox

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
    const context = makeContext(makeSandbox(true));

    const promise = bashCommand.execute(config, context);

    // Simulate sandbox-exec failing to spawn (ENOENT)
    setTimeout(() => {
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      failProc.emit('error', err);
    }, 10);

    // Fallback child should succeed
    setTimeout(() => {
      fallbackProc.stdout.emit('data', Buffer.from('hello\n'));
      fallbackProc.emit('close', 0, null);
    }, 30);

    const result = await promise;

    // Two spawn calls: sandbox-exec (failed) then bash (fallback)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.data.stdout).toBe('hello');
  });
});
