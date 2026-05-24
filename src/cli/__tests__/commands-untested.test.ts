/**
 * Tests for CLI commands with zero prior coverage:
 *   benchmark, diagnose, gate, epic
 *
 * Structural + basic smoke tests following the commands-deep.test.ts pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any command imports
// ---------------------------------------------------------------------------

vi.mock('../mcp-client.js', () => ({
  callMCPTool: vi.fn(async () => ({})),
  MCPClientError: class MCPClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MCPClientError';
    }
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ isDirectory: () => true, isFile: () => true })),
    unlink: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    cp: vi.fn(async () => undefined),
  },
  readFile: vi.fn(async () => '{}'),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isDirectory: () => true, isFile: () => true })),
  unlink: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  cp: vi.fn(async () => undefined),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  execFileSync: vi.fn(() => ''),
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(() => ({
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    pid: 12345,
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock the spell-gate service so gate command doesn't call process.exit
vi.mock('../services/spell-gate.js', () => ({
  processGateCommand: vi.fn(),
}));

// Mock the output module to suppress console noise in tests
vi.mock('../output.js', () => {
  const noop = () => {};
  const identity = (s: unknown) => String(s ?? '');
  return {
    output: {
      writeln: vi.fn(),
      bold: identity,
      dim: identity,
      highlight: identity,
      success: identity,
      error: identity,
      printError: vi.fn(),
      printSuccess: vi.fn(),
      printInfo: vi.fn(),
      printList: vi.fn(),
      printTable: vi.fn(),
      printBox: vi.fn(),
      createSpinner: () => ({
        start: noop,
        stop: noop,
        setText: noop,
        succeed: noop,
        fail: noop,
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { benchmarkCommand } from '../commands/benchmark.js';
import { diagnoseCommand } from '../commands/diagnose.js';
import gateCommand from '../commands/gate.js';
import epicCommand from '../commands/epic.js';

import type { Command, CommandContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectValidCommand(cmd: Command, expectedName: string) {
  expect(cmd).toBeDefined();
  expect(cmd.name).toBe(expectedName);
  expect(typeof cmd.description).toBe('string');
  expect(cmd.description.length).toBeGreaterThan(0);
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    args: [],
    flags: { _: [] },
    cwd: '/tmp/test',
    interactive: false,
    ...overrides,
  };
}

// ============================================================================
// 1. benchmark
// ============================================================================

describe('benchmark command', () => {
  it('should have correct name and description', () => {
    expectValidCommand(benchmarkCommand, 'benchmark');
  });

  it('should have subcommands: pretrain, neural, memory, all', () => {
    expect(benchmarkCommand.subcommands).toBeDefined();
    expect(benchmarkCommand.subcommands!.length).toBeGreaterThanOrEqual(4);
    const subNames = benchmarkCommand.subcommands!.map(s => s.name);
    expect(subNames).toContain('pretrain');
    expect(subNames).toContain('neural');
    expect(subNames).toContain('memory');
    expect(subNames).toContain('all');
  });

  it('should have examples', () => {
    expect(benchmarkCommand.examples).toBeDefined();
    expect(benchmarkCommand.examples!.length).toBeGreaterThan(0);
  });

  it('should have an action function', () => {
    expect(typeof benchmarkCommand.action).toBe('function');
  });

  it('action returns success when called without subcommand (shows help)', async () => {
    const result = await benchmarkCommand.action!(makeCtx());
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
  });

  it('each subcommand should have name, description, and action', () => {
    for (const sub of benchmarkCommand.subcommands!) {
      expect(typeof sub.name).toBe('string');
      expect(typeof sub.description).toBe('string');
      expect(typeof sub.action).toBe('function');
    }
  });

  it('each subcommand should have examples', () => {
    for (const sub of benchmarkCommand.subcommands!) {
      expect(sub.examples).toBeDefined();
      expect(sub.examples!.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// 2. diagnose
// ============================================================================

describe('diagnose command', () => {
  it('should have correct name and description', () => {
    expectValidCommand(diagnoseCommand, 'diagnose');
  });

  it('should have alias "diag"', () => {
    expect(diagnoseCommand.aliases).toBeDefined();
    expect(diagnoseCommand.aliases).toContain('diag');
  });

  it('should expose options including --suite, --verbose, --json', () => {
    expect(diagnoseCommand.options).toBeDefined();
    const names = diagnoseCommand.options!.map(o => o.name);
    expect(names).toContain('suite');
    expect(names).toContain('verbose');
    expect(names).toContain('json');
  });

  it('should have examples', () => {
    expect(diagnoseCommand.examples).toBeDefined();
    expect(diagnoseCommand.examples!.length).toBeGreaterThan(0);
  });

  it('should have an action function', () => {
    expect(typeof diagnoseCommand.action).toBe('function');
  });

  it('action returns failure for unknown suite name', async () => {
    const result = await diagnoseCommand.action!(makeCtx({
      flags: { _: [], suite: 'nonexistent-suite' },
    }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });
});

// ============================================================================
// 3. gate
// ============================================================================

describe('gate command', () => {
  it('should have correct name and description', () => {
    expectValidCommand(gateCommand, 'gate');
  });

  it('should have examples', () => {
    expect(gateCommand.examples).toBeDefined();
    expect(gateCommand.examples!.length).toBeGreaterThan(0);
  });

  it('should have an action function', () => {
    expect(typeof gateCommand.action).toBe('function');
  });

  it('action returns success when called with no subcommand (shows usage)', async () => {
    const result = await gateCommand.action!(makeCtx({ args: [] }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
  });

  it('action delegates to processGateCommand when a subcommand is given', async () => {
    const { processGateCommand } = await import('../services/spell-gate.js');
    const mockProcess = vi.mocked(processGateCommand);
    mockProcess.mockClear();

    await gateCommand.action!(makeCtx({ args: ['check-before-scan'] }));
    expect(mockProcess).toHaveBeenCalledWith('check-before-scan');
  });
});

// ============================================================================
// 4. epic
// ============================================================================

describe('epic command', () => {
  it('should have correct name and description', () => {
    expectValidCommand(epicCommand, 'epic');
  });

  it('should have examples', () => {
    expect(epicCommand.examples).toBeDefined();
    expect(epicCommand.examples!.length).toBeGreaterThan(0);
  });

  it('should have an action function', () => {
    expect(typeof epicCommand.action).toBe('function');
  });

  it('action returns success when called with no subcommand (shows usage)', async () => {
    const result = await epicCommand.action!(makeCtx({ args: [] }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
  });

  it('action returns failure for "run" without a source argument', async () => {
    const result = await epicCommand.action!(makeCtx({ args: ['run'], flags: { _: [] } }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });

  it('action returns failure for "status" without a feature-id', async () => {
    const result = await epicCommand.action!(makeCtx({ args: ['status'], flags: { _: [] } }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });

  it('action returns failure for "reset" without a feature-id', async () => {
    const result = await epicCommand.action!(makeCtx({ args: ['reset'], flags: { _: [] } }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });

  it('action returns failure for unknown subcommand', async () => {
    const result = await epicCommand.action!(makeCtx({ args: ['bogus'], flags: { _: [] } }));
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });
});
