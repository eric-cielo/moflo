/**
 * Tests for CLI commands with zero prior coverage:
 *   appliance-advanced, benchmark, diagnose, gate, epic, transfer-store
 *
 * Structural + basic smoke tests following the commands-deep.test.ts pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any command imports
// ---------------------------------------------------------------------------

vi.mock('../src/mcp-client.js', () => ({
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
vi.mock('../src/services/spell-gate.js', () => ({
  processGateCommand: vi.fn(),
}));

// Mock the transfer/index for transfer-store command
vi.mock('../src/transfer/index.js', () => ({
  createPatternStore: vi.fn(),
  createDiscoveryService: vi.fn(() => ({
    discoverRegistry: vi.fn(async () => ({
      success: true,
      source: 'mock',
      registry: {
        patterns: [],
        featured: [],
        trending: [],
        newest: [],
        totalPatterns: 0,
      },
    })),
  })),
  createDownloader: vi.fn(),
  createPublisher: vi.fn(),
  searchPatterns: vi.fn(() => ({ patterns: [], total: 0 })),
}));

// Mock the output module to suppress console noise in tests
vi.mock('../src/output.js', () => {
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

import { signCommand, publishCommand, updateAppCommand } from '../src/commands/appliance-advanced.js';
import { benchmarkCommand } from '../src/commands/benchmark.js';
import { diagnoseCommand } from '../src/commands/diagnose.js';
import gateCommand from '../src/commands/gate.js';
import epicCommand from '../src/commands/epic.js';
import {
  storeCommand,
  storeListCommand,
  storeSearchCommand,
  storeDownloadCommand,
  storePublishCommand,
  storeInfoCommand,
} from '../src/commands/transfer-store.js';

import type { Command, CommandContext } from '../src/types.js';

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
// 1. appliance-advanced
// ============================================================================

describe('appliance-advanced commands', () => {
  describe('signCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(signCommand, 'sign');
    });

    it('should expose options including --file and --key', () => {
      expect(signCommand.options).toBeDefined();
      const names = signCommand.options!.map(o => o.name);
      expect(names).toContain('file');
      expect(names).toContain('key');
    });

    it('should have an action function', () => {
      expect(typeof signCommand.action).toBe('function');
    });

    it('action returns failure when --file is missing', async () => {
      const result = await signCommand.action!(makeCtx({ flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });

  describe('publishCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(publishCommand, 'publish');
    });

    it('should expose options including --file', () => {
      const names = publishCommand.options!.map(o => o.name);
      expect(names).toContain('file');
    });

    it('should have an action function', () => {
      expect(typeof publishCommand.action).toBe('function');
    });

    it('action returns failure when --file is missing', async () => {
      const result = await publishCommand.action!(makeCtx({ flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });

  describe('updateAppCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(updateAppCommand, 'update');
    });

    it('should expose options including --file and --section', () => {
      const names = updateAppCommand.options!.map(o => o.name);
      expect(names).toContain('file');
      expect(names).toContain('section');
    });

    it('should have an action function', () => {
      expect(typeof updateAppCommand.action).toBe('function');
    });

    it('action returns failure when required flags are missing', async () => {
      const result = await updateAppCommand.action!(makeCtx({ flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });
});

// ============================================================================
// 2. benchmark
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
// 3. diagnose
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
// 4. gate
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
    const { processGateCommand } = await import('../src/services/spell-gate.js');
    const mockProcess = vi.mocked(processGateCommand);
    mockProcess.mockClear();

    await gateCommand.action!(makeCtx({ args: ['check-before-scan'] }));
    expect(mockProcess).toHaveBeenCalledWith('check-before-scan');
  });
});

// ============================================================================
// 5. epic
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

// ============================================================================
// 6. transfer-store
// ============================================================================

describe('transfer-store commands', () => {
  describe('storeCommand (parent)', () => {
    it('should have correct name and description', () => {
      expectValidCommand(storeCommand, 'store');
    });

    it('should have 5 subcommands: list, search, download, publish, info', () => {
      expect(storeCommand.subcommands).toBeDefined();
      expect(storeCommand.subcommands!.length).toBe(5);
      const subNames = storeCommand.subcommands!.map(s => s.name);
      expect(subNames).toContain('list');
      expect(subNames).toContain('search');
      expect(subNames).toContain('download');
      expect(subNames).toContain('publish');
      expect(subNames).toContain('info');
    });

    it('should have examples', () => {
      expect(storeCommand.examples).toBeDefined();
      expect(storeCommand.examples!.length).toBeGreaterThan(0);
    });

    it('should have an action function', () => {
      expect(typeof storeCommand.action).toBe('function');
    });

    it('action returns success when called without subcommand (shows help)', async () => {
      const result = await storeCommand.action!(makeCtx());
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
    });
  });

  describe('storeListCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(storeListCommand, 'list');
    });

    it('should have aliases', () => {
      expect(storeListCommand.aliases).toContain('ls');
    });

    it('should have options including --category and --featured', () => {
      const names = storeListCommand.options!.map(o => o.name);
      expect(names).toContain('category');
      expect(names).toContain('featured');
    });

    it('should have examples', () => {
      expect(storeListCommand.examples).toBeDefined();
      expect(storeListCommand.examples!.length).toBeGreaterThan(0);
    });

    it('should have an action function', () => {
      expect(typeof storeListCommand.action).toBe('function');
    });
  });

  describe('storeSearchCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(storeSearchCommand, 'search');
    });

    it('should have options including --query', () => {
      const names = storeSearchCommand.options!.map(o => o.name);
      expect(names).toContain('query');
    });

    it('should have examples', () => {
      expect(storeSearchCommand.examples).toBeDefined();
      expect(storeSearchCommand.examples!.length).toBeGreaterThan(0);
    });

    it('should have an action function', () => {
      expect(typeof storeSearchCommand.action).toBe('function');
    });

    it('action returns failure when query is missing', async () => {
      const result = await storeSearchCommand.action!(makeCtx({ args: [], flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });

  describe('storeDownloadCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(storeDownloadCommand, 'download');
    });

    it('should have aliases', () => {
      expect(storeDownloadCommand.aliases).toContain('get');
      expect(storeDownloadCommand.aliases).toContain('install');
    });

    it('should have options including --name', () => {
      const names = storeDownloadCommand.options!.map(o => o.name);
      expect(names).toContain('name');
    });

    it('should have examples', () => {
      expect(storeDownloadCommand.examples).toBeDefined();
      expect(storeDownloadCommand.examples!.length).toBeGreaterThan(0);
    });

    it('should have an action function', () => {
      expect(typeof storeDownloadCommand.action).toBe('function');
    });

    it('action returns failure when pattern name is missing', async () => {
      const result = await storeDownloadCommand.action!(makeCtx({ args: [], flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });

  describe('storePublishCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(storePublishCommand, 'publish');
    });

    it('should have aliases', () => {
      expect(storePublishCommand.aliases).toContain('contribute');
    });

    it('should have options including --input, --name, --description', () => {
      const names = storePublishCommand.options!.map(o => o.name);
      expect(names).toContain('input');
      expect(names).toContain('name');
      expect(names).toContain('description');
    });

    it('should have examples', () => {
      expect(storePublishCommand.examples).toBeDefined();
      expect(storePublishCommand.examples!.length).toBeGreaterThan(0);
    });

    it('should have an action function', () => {
      expect(typeof storePublishCommand.action).toBe('function');
    });

    it('action returns failure when required flags are missing', async () => {
      const result = await storePublishCommand.action!(makeCtx({ flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });

  describe('storeInfoCommand', () => {
    it('should have correct name and description', () => {
      expectValidCommand(storeInfoCommand, 'info');
    });

    it('should have options including --name', () => {
      const names = storeInfoCommand.options!.map(o => o.name);
      expect(names).toContain('name');
    });

    it('should have examples', () => {
      expect(storeInfoCommand.examples).toBeDefined();
      expect(storeInfoCommand.examples!.length).toBeGreaterThan(0);
    });

    it('should have an action function', () => {
      expect(typeof storeInfoCommand.action).toBe('function');
    });

    it('action returns failure when pattern name is missing', async () => {
      const result = await storeInfoCommand.action!(makeCtx({ args: [], flags: { _: [] } }));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
    });
  });
});
