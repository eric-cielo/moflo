/**
 * V3 CLI Commands Tests
 * Tests for agent, swarm, memory, and config commands
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetStateRootCacheForTest } from '../services/project-root.js';
import { cliConfigPath } from '../config/cli-config-store.js';
import { agentCommand } from '../commands/agent.js';
import { swarmCommand } from '../commands/swarm.js';
import { memoryCommand } from '../commands/memory.js';
import { configCommand } from '../commands/config.js';
import type { CommandContext } from '../types.js';

// Mock MCP client — tool names use underscores (e.g. 'agent_spawn') matching callMCPTool calls
vi.mock('../mcp-client.js', () => ({
  callMCPTool: vi.fn(async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === 'agent_spawn') {
      return {
        agentId: input.id || 'mock-agent-123',
        agentType: (input.agentType as string) || 'coder',
        status: 'active',
        createdAt: new Date().toISOString()
      };
    }

    if (toolName === 'agent_list') {
      return {
        agents: [
          { agentId: 'agent-1', agentType: 'coder', status: 'active', createdAt: '2024-01-01T00:00:00Z' },
          { agentId: 'agent-2', agentType: 'tester', status: 'idle', createdAt: '2024-01-01T00:01:00Z' }
        ],
        total: 2
      };
    }

    if (toolName === 'agent_status') {
      return {
        id: input.agentId,
        agentType: 'coder',
        status: 'active',
        createdAt: '2024-01-01T00:00:00Z',
        lastActivityAt: new Date().toISOString(),
        metrics: {
          tasksCompleted: 10,
          tasksInProgress: 2,
          tasksFailed: 1,
          averageExecutionTime: 1500,
          uptime: 3600000
        }
      };
    }

    if (toolName === 'agent_terminate') {
      return {
        agentId: input.agentId,
        terminated: true,
        terminatedAt: new Date().toISOString()
      };
    }

    if (toolName === 'swarm_init') {
      return {
        swarmId: 'swarm-mock-123',
        topology: input.topology || 'hierarchical',
        initializedAt: new Date().toISOString(),
        config: {
          topology: input.topology || 'hierarchical',
          maxAgents: input.maxAgents || 15,
          currentAgents: 0,
          autoScaling: true
        }
      };
    }

    if (toolName === 'memory_stats') {
      return {
        totalEntries: 42,
        totalSize: '1.2 MB',
        version: '3.0.0-alpha',
        backend: 'hybrid',
        location: './data/memory',
        oldestEntry: '2024-01-01T00:00:00Z',
        newestEntry: '2024-01-07T00:00:00Z'
      };
    }

    return {};
  }),
  MCPClientError: class MCPClientError extends Error {
    constructor(message: string, public toolName: string, public cause?: Error) {
      super(message);
      this.name = 'MCPClientError';
    }
  }
}));

// Mock memory-initializer (used by memory store/retrieve/search/list/delete via dynamic import)
vi.mock('../memory/memory-initializer.js', () => ({
  storeEntry: vi.fn(async (opts: { key: string; value: string; namespace?: string }) => ({
    success: true,
    id: 'mock-entry-id-123456789012345678',
    embedding: { dimensions: 384 }
  })),
  getEntry: vi.fn(async (opts: { key: string; namespace?: string }) => ({
    success: true,
    found: true,
    entry: {
      key: opts.key,
      namespace: opts.namespace || 'default',
      content: 'mock-value-for-' + opts.key,
      accessCount: 5,
      tags: ['test'],
      hasEmbedding: false
    }
  })),
  searchEntries: vi.fn(async (opts: { query: string }) => ({
    success: true,
    results: [
      { key: 'result-1', content: 'auth pattern 1', score: 0.95, namespace: 'default' },
      { key: 'result-2', content: 'auth pattern 2', score: 0.85, namespace: 'default' }
    ],
    searchTime: 0.5
  })),
  listEntries: vi.fn(async () => ({
    success: true,
    entries: [
      { key: 'entry-1', namespace: 'default', size: 100, hasEmbedding: false, accessCount: 10, updatedAt: '2024-01-01T00:00:00Z' },
      { key: 'entry-2', namespace: 'default', size: 200, hasEmbedding: true, accessCount: 5, updatedAt: '2024-01-01T00:01:00Z' }
    ],
    total: 2
  })),
  deleteEntry: vi.fn(async (opts: { key: string; namespace?: string }) => ({
    success: true,
    deleted: true,
    remainingEntries: 41
  })),
  getHNSWIndex: vi.fn(async () => null),
  getHNSWStatus: vi.fn(() => ({ entryCount: 0, dimensions: 384 })),
  generateEmbedding: vi.fn(async () => new Float32Array(384)),
  initializeMemoryDatabase: vi.fn(async () => true),
  loadEmbeddingModel: vi.fn(async () => true),
  verifyMemoryInit: vi.fn(async () => ({ success: true }))
}));

// Mock moflo-require (imported by memory.ts)
vi.mock('../services/moflo-require.js', () => ({
  mofloImport: vi.fn(async () => ({ default: {} }))
}));

// Mock output
vi.mock('../output.js', () => ({
  output: {
    writeln: vi.fn(),
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
    printTable: vi.fn(),
    printJson: vi.fn(),
    printList: vi.fn(),
    printBox: vi.fn(),
    createSpinner: vi.fn(() => ({
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn()
    })),
    highlight: (str: string) => str,
    bold: (str: string) => str,
    dim: (str: string) => str,
    success: (str: string) => str,
    error: (str: string) => str,
    warning: (str: string) => str,
    info: (str: string) => str,
    progressBar: () => '[=====>    ]',
    setColorEnabled: vi.fn()
  }
}));

// Mock prompts (always return default values for non-interactive tests)
vi.mock('../prompt.js', () => ({
  select: vi.fn(async (opts) => opts.default || opts.options[0]?.value),
  confirm: vi.fn(async (opts) => opts.default ?? false),
  input: vi.fn(async (opts) => opts.default || 'test-input'),
  multiSelect: vi.fn(async (opts) => opts.default || [])
}));

describe('Agent Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('agent spawn', () => {
    it('should spawn agent with type flag', async () => { // Skip: requires live MCP context
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');
      expect(spawnCmd).toBeDefined();

      ctx.flags = { type: 'coder', _: [] };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agentId');
      expect(result.data).toHaveProperty('agentType', 'coder');
    });

    it('should spawn agent with custom name', async () => { // Skip: requires live MCP context
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = { type: 'tester', name: 'my-tester', _: [] };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agentId', 'my-tester');
    });

    it('should fail without agent type in non-interactive mode', async () => {
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = { _: [] };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should pass provider and model options', async () => {
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = {
        type: 'coder',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        _: []
      };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it('should handle task option', async () => {
      const spawnCmd = agentCommand.subcommands?.find(c => c.name === 'spawn');

      ctx.flags = {
        type: 'researcher',
        task: 'Research React patterns',
        _: []
      };
      const result = await spawnCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });

  describe('agent list', () => {
    it('should list all agents', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');
      expect(listCmd).toBeDefined();

      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents');
      expect(result.data).toHaveProperty('total', 2);
    });

    it('should filter by agent type', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');

      ctx.flags = { type: 'coder', _: [] };
      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it('should filter by status', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');

      ctx.flags = { status: 'active', _: [] };
      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it('should include inactive agents with --all flag', async () => { // Skip: requires live MCP context
      const listCmd = agentCommand.subcommands?.find(c => c.name === 'list');

      ctx.flags = { all: true, _: [] };
      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });

  describe('agent status', () => {
    it('should show agent status', async () => { // Skip: requires live MCP context
      const statusCmd = agentCommand.subcommands?.find(c => c.name === 'status');
      expect(statusCmd).toBeDefined();

      ctx.args = ['agent-123'];
      const result = await statusCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('id');
      expect(result.data).toHaveProperty('status');
      expect(result.data).toHaveProperty('metrics');
    });

    it('should fail without agent ID', async () => {
      const statusCmd = agentCommand.subcommands?.find(c => c.name === 'status');

      ctx.args = [];
      ctx.interactive = false;
      const result = await statusCmd!.action!(ctx);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('agent stop', () => {
    it('should stop agent', async () => { // Skip: requires live MCP context
      const stopCmd = agentCommand.subcommands?.find(c => c.name === 'stop');
      expect(stopCmd).toBeDefined();

      ctx.args = ['agent-123'];
      ctx.flags = { force: true, _: [] };
      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agentId', 'agent-123');
      expect(result.data).toHaveProperty('terminated', true);
    });

    it('should fail without agent ID', async () => {
      const stopCmd = agentCommand.subcommands?.find(c => c.name === 'stop');

      ctx.args = [];
      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('agent metrics', () => {
    it('should show agent metrics', async () => {
      const metricsCmd = agentCommand.subcommands?.find(c => c.name === 'metrics');
      expect(metricsCmd).toBeDefined();

      const result = await metricsCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('summary');
      expect(result.data).toHaveProperty('byType');
    });

    it('should accept period option', async () => {
      const metricsCmd = agentCommand.subcommands?.find(c => c.name === 'metrics');

      ctx.flags = { period: '7d', _: [] };
      const result = await metricsCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });
  });
});

describe('Swarm Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('swarm init', () => {
    it('should initialize swarm with default topology', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');
      expect(initCmd).toBeDefined();

      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('swarmId');
      expect(result.data).toHaveProperty('topology');
    });

    it('should initialize swarm with custom topology', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { topology: 'mesh', _: [] };
      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('topology', 'mesh');
    });

    it('should enable V3 mode', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { v3Mode: true, _: [] };
      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
    });

    it('should set max agents', async () => { // Skip: requires live MCP context
      const initCmd = swarmCommand.subcommands?.find(c => c.name === 'init');

      ctx.flags = { maxAgents: 20, _: [] };
      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data?.config).toHaveProperty('maxAgents', 20);
    });
  });

  describe('swarm start', () => {
    it('should start swarm with objective', async () => {
      const startCmd = swarmCommand.subcommands?.find(c => c.name === 'start');
      expect(startCmd).toBeDefined();

      ctx.flags = { objective: 'Build REST API', _: [] };
      const result = await startCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('objective', 'Build REST API');
    });

    it('should fail without objective', async () => {
      const startCmd = swarmCommand.subcommands?.find(c => c.name === 'start');

      const result = await startCmd!.action!(ctx);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should accept strategy option', async () => {
      const startCmd = swarmCommand.subcommands?.find(c => c.name === 'start');

      ctx.flags = { objective: 'Test project', strategy: 'testing', _: [] };
      const result = await startCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('strategy', 'testing');
    });
  });

  describe('swarm status', () => {
    it('should show swarm status', async () => {
      const statusCmd = swarmCommand.subcommands?.find(c => c.name === 'status');
      expect(statusCmd).toBeDefined();

      const result = await statusCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents');
      expect(result.data).toHaveProperty('tasks');
      expect(result.data).toHaveProperty('metrics');
    });
  });

  describe('swarm stop', () => {
    it('should stop swarm', async () => {
      const stopCmd = swarmCommand.subcommands?.find(c => c.name === 'stop');
      expect(stopCmd).toBeDefined();

      ctx.args = ['swarm-123'];
      ctx.flags = { force: true, _: [] };
      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('swarmId', 'swarm-123');
      expect(result.data).toHaveProperty('stopped', true);
    });

    it('should fail without swarm ID', async () => {
      const stopCmd = swarmCommand.subcommands?.find(c => c.name === 'stop');

      const result = await stopCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('swarm scale', () => {
    it('should scale swarm', async () => {
      const scaleCmd = swarmCommand.subcommands?.find(c => c.name === 'scale');
      expect(scaleCmd).toBeDefined();

      ctx.args = ['swarm-123'];
      ctx.flags = { agents: 20, _: [] };
      const result = await scaleCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents', 20);
    });

    it('should fail without target agent count', async () => {
      const scaleCmd = swarmCommand.subcommands?.find(c => c.name === 'scale');

      ctx.args = ['swarm-123'];
      const result = await scaleCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('swarm coordinate', () => {
    it('should show V3 coordination structure', async () => {
      const coordinateCmd = swarmCommand.subcommands?.find(c => c.name === 'coordinate');
      expect(coordinateCmd).toBeDefined();

      const result = await coordinateCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('agents');
      expect(result.data?.agents).toHaveLength(15);
    });
  });
});

describe('Memory Commands', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = {
      args: [],
      flags: { _: [] },
      cwd: '/test',
      interactive: false
    };
  });

  describe('memory store', () => {
    it('should store data', async () => { // Skip: requires live memory service
      const storeCmd = memoryCommand.subcommands?.find(c => c.name === 'store');
      expect(storeCmd).toBeDefined();

      ctx.flags = { key: 'test-key', value: 'test-value', _: [] };
      const result = await storeCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key', 'test-key');
    });

    it('should fail without key', async () => {
      const storeCmd = memoryCommand.subcommands?.find(c => c.name === 'store');

      ctx.flags = { value: 'test-value', _: [] };
      const result = await storeCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('memory retrieve', () => {
    it('should retrieve data', async () => { // Skip: requires live memory service
      const retrieveCmd = memoryCommand.subcommands?.find(c => c.name === 'retrieve');
      expect(retrieveCmd).toBeDefined();

      ctx.args = ['test-key'];
      const result = await retrieveCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key', 'test-key');
    });
  });

  describe('memory search', () => {
    it('should search memory', async () => {
      const searchCmd = memoryCommand.subcommands?.find(c => c.name === 'search');
      expect(searchCmd).toBeDefined();

      ctx.flags = { query: 'authentication', _: [] };
      const result = await searchCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('should fail without query', async () => {
      const searchCmd = memoryCommand.subcommands?.find(c => c.name === 'search');

      const result = await searchCmd!.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('memory list', () => {
    it('should list memory entries', async () => {
      const listCmd = memoryCommand.subcommands?.find(c => c.name === 'list');
      expect(listCmd).toBeDefined();

      const result = await listCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('memory delete', () => {
    it('should delete entry', async () => { // Skip: requires live memory service
      const deleteCmd = memoryCommand.subcommands?.find(c => c.name === 'delete');
      expect(deleteCmd).toBeDefined();

      ctx.args = ['test-key'];
      ctx.flags = { force: true, _: [] };
      const result = await deleteCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('deleted', true);
    });
  });

  describe('memory stats', () => {
    it('should show memory statistics', async () => { // Skip: requires live memory service
      const statsCmd = memoryCommand.subcommands?.find(c => c.name === 'stats');
      expect(statsCmd).toBeDefined();

      const result = await statsCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('entries');
      expect(result.data).toHaveProperty('storage');
      expect(result.data).toHaveProperty('backend');
      expect(result.data).toHaveProperty('version');
    });
  });

  describe('memory configure', () => {
    it('should configure memory backend', async () => {
      const configureCmd = memoryCommand.subcommands?.find(c => c.name === 'configure');
      expect(configureCmd).toBeDefined();

      ctx.flags = { backend: 'agentdb', _: [] };
      const result = await configureCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('backend', 'agentdb');
    });
  });
});

describe('Config Commands', () => {
  let ctx: CommandContext;
  let projectDir: string;
  let envBackup: string | undefined;

  // `flo config` writes real files, so every case gets a throwaway project
  // root. CLAUDE_PROJECT_DIR is authoritative for `resolveStateRoot`, so it
  // must point at the fixture — otherwise a test run inside a Claude Code
  // session resolves to the developer's actual repo and writes there.
  // realpathSync both sides: macOS hands out /var/folders paths that resolve
  // to /private/var/folders, and resolveStateRoot canonicalizes.
  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-config-test-')));
    envBackup = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    _resetStateRootCacheForTest();

    ctx = {
      args: [],
      flags: { _: [] },
      cwd: projectDir,
      interactive: false
    };
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = envBackup;
    _resetStateRootCacheForTest();
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Use the store's own resolver rather than rebuilding the path — a literal
  // here would silently fork from CLI_CONFIG_CANDIDATES[0].
  const configFile = () => cliConfigPath(projectDir);
  const readConfigFile = () => JSON.parse(readFileSync(configFile(), 'utf8'));
  const subcommand = (name: string) => configCommand.subcommands!.find(c => c.name === name)!;
  const runInit = async () => subcommand('init').action!({ ...ctx, flags: { _: [] } });

  describe('config init', () => {
    it('should initialize configuration', async () => {
      const initCmd = subcommand('init');
      expect(initCmd).toBeDefined();

      const result = await initCmd!.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('version');
    });

    // The regression this whole module exists for: `init` reported success
    // without writing anything, so the healer's `Config File` auto-fix claimed
    // "applied" on every run while the warning never cleared.
    it('writes a parseable config file to disk', async () => {
      const result = await runInit();

      expect(result.success).toBe(true);
      expect(existsSync(configFile())).toBe(true);
      expect(readConfigFile()).toMatchObject({ version: '3.0.0', swarm: { topology: 'hybrid' } });
    });

    it('should initialize with V3 mode', async () => {
      const initCmd = subcommand('init');

      ctx.flags = { v3: true, _: [] };
      const result = await initCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('v3Mode', true);
      expect(readConfigFile()).toMatchObject({ v3Mode: true });
    });

    it('refuses to clobber an existing config without --force', async () => {
      await runInit();
      await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.maxAgents', value: '42', _: [] } });

      const result = await subcommand('init').action!({ ...ctx, flags: { _: [] } });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(readConfigFile().swarm.maxAgents).toBe(42);
    });

    it('overwrites an existing config with --force', async () => {
      await runInit();
      await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.maxAgents', value: '42', _: [] } });

      const result = await subcommand('init').action!({ ...ctx, flags: { force: true, _: [] } });

      expect(result.success).toBe(true);
      expect(readConfigFile().swarm.maxAgents).toBe(15);
    });
  });

  describe('config get', () => {
    it('should get configuration value', async () => {
      const getCmd = subcommand('get');
      expect(getCmd).toBeDefined();

      ctx.args = ['swarm.topology'];
      const result = await getCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key');
      expect(result.data).toHaveProperty('value');
    });

    it('should show all config when no key provided', async () => {
      const getCmd = subcommand('get');

      const result = await getCmd.action!(ctx);

      expect(result.success).toBe(true);
    });

    it('reads back what set wrote, not a hardcoded default', async () => {
      await runInit();
      await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.topology', value: 'mesh', _: [] } });

      const result = await subcommand('get').action!({ ...ctx, args: ['swarm.topology'], flags: { _: [] } });

      expect(result.data).toEqual({ key: 'swarm.topology', value: 'mesh' });
    });

    it('fails on an unknown key', async () => {
      const result = await subcommand('get').action!({ ...ctx, args: ['swarm.nonesuch'], flags: { _: [] } });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('config set', () => {
    it('should set configuration value', async () => {
      const setCmd = subcommand('set');
      expect(setCmd).toBeDefined();

      ctx.flags = { key: 'swarm.maxAgents', value: '20', _: [] };
      const result = await setCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('key', 'swarm.maxAgents');
      // Coerced to the type already at that key, so the stored value is usable
      // as a number rather than the string the shell handed us.
      expect(result.data).toHaveProperty('value', 20);
      expect(readConfigFile().swarm.maxAgents).toBe(20);
    });

    it('coerces booleans and rejects non-numbers for numeric keys', async () => {
      const ok = await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.autoScale', value: 'false', _: [] } });
      expect(ok.success).toBe(true);
      expect(readConfigFile().swarm.autoScale).toBe(false);

      const bad = await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.maxAgents', value: 'lots', _: [] } });
      expect(bad.success).toBe(false);
      expect(readConfigFile().swarm.maxAgents).toBe(15);
    });

    it('rejects an unknown key instead of silently creating it', async () => {
      const result = await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.nonesuch', value: '1', _: [] } });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(existsSync(configFile())).toBe(false);
    });

    it('should fail without key and value', async () => {
      const setCmd = subcommand('set');

      const result = await setCmd.action!(ctx);

      expect(result.success).toBe(false);
    });
  });

  describe('config providers', () => {
    it('should list providers', async () => {
      const providersCmd = subcommand('providers');
      expect(providersCmd).toBeDefined();

      const result = await providersCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('persists --enable / --disable instead of ignoring the flag', async () => {
      await runInit();

      await subcommand('providers').action!({ ...ctx, flags: { enable: 'ollama', _: [] } });
      expect(readConfigFile().providers.find((p: { name: string }) => p.name === 'ollama').enabled).toBe(true);

      await subcommand('providers').action!({ ...ctx, flags: { disable: 'ollama', _: [] } });
      expect(readConfigFile().providers.find((p: { name: string }) => p.name === 'ollama').enabled).toBe(false);
    });

    it('fails on an unknown provider', async () => {
      const result = await subcommand('providers').action!({ ...ctx, flags: { enable: 'nonesuch', _: [] } });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('config reset', () => {
    it('should reset configuration', async () => {
      const resetCmd = subcommand('reset');
      expect(resetCmd).toBeDefined();

      ctx.flags = { force: true, _: [] };
      const result = await resetCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('reset', true);
    });

    it('restores changed values on disk', async () => {
      await runInit();
      await subcommand('set').action!({ ...ctx, flags: { key: 'swarm.maxAgents', value: '99', _: [] } });

      await subcommand('reset').action!({ ...ctx, flags: { force: true, section: 'swarm', _: [] } });

      expect(readConfigFile().swarm.maxAgents).toBe(15);
    });
  });

  describe('config export', () => {
    it('should export configuration', async () => {
      const exportCmd = subcommand('export');
      expect(exportCmd).toBeDefined();

      const result = await exportCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('config');
    });

    it('writes the export file it reports', async () => {
      await runInit();

      const result = await subcommand('export').action!({ ...ctx, flags: { output: 'out/cfg.json', _: [] } });

      expect(result.success).toBe(true);
      const exported = JSON.parse(readFileSync(join(projectDir, 'out', 'cfg.json'), 'utf8'));
      expect(exported).toMatchObject({ version: '3.0.0' });
      expect(exported.exportedAt).toBeTruthy();
    });
  });

  describe('config import', () => {
    it('should import configuration', async () => {
      const importCmd = subcommand('import');
      expect(importCmd).toBeDefined();

      writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ swarm: { topology: 'ring', maxAgents: 7 } }));
      ctx.flags = { file: './config.json', _: [] };
      const result = await importCmd.action!(ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('imported', true);
      expect(readConfigFile()).toMatchObject({ swarm: { topology: 'ring', maxAgents: 7 } });
    });

    it('fails when the source file does not exist', async () => {
      const result = await subcommand('import').action!({ ...ctx, flags: { file: './nope.json', _: [] } });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should fail without file path', async () => {
      const importCmd = subcommand('import');

      const result = await importCmd.action!(ctx);

      expect(result.success).toBe(false);
    });
  });
});
