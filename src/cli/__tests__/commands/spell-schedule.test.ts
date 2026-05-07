/**
 * Spell Schedule Command Tests
 *
 * Tests the schedule subcommand: create, list, cancel.
 * Mocks MCP tools and daemon readiness for isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext, CommandResult } from '../../types.js';

// Mock MCP client
vi.mock('../../mcp-client.js', () => ({
  callMCPTool: vi.fn(),
  MCPClientError: class MCPClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MCPClientError';
    }
  },
}));

// Mock daemon readiness
vi.mock('../../services/daemon-readiness.js', () => ({
  ensureDaemonForScheduling: vi.fn(),
}));

// Mock output (suppress console output in tests)
vi.mock('../../output.js', () => {
  const noopFmt = (s: unknown) => String(s ?? '');
  return {
    output: {
      writeln: vi.fn(),
      printError: vi.fn(),
      printSuccess: vi.fn(),
      printWarning: vi.fn(),
      printInfo: vi.fn(),
      printBox: vi.fn(),
      printJson: vi.fn(),
      printTable: vi.fn(),
      printList: vi.fn(),
      bold: noopFmt,
      highlight: noopFmt,
      success: noopFmt,
      error: noopFmt,
      dim: noopFmt,
      warning: noopFmt,
      createSpinner: () => ({ start: vi.fn(), succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() }),
    },
  };
});

import { callMCPTool } from '../../mcp-client.js';
import { ensureDaemonForScheduling } from '../../services/daemon-readiness.js';
import { scheduleCommand } from '../../commands/spell-schedule.js';

const mockCallMCP = vi.mocked(callMCPTool);
const mockEnsureDaemon = vi.mocked(ensureDaemonForScheduling);

// Helper to find a subcommand
function findSub(name: string) {
  return scheduleCommand.subcommands!.find(c => c.name === name)!;
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    args: [],
    flags: { _: [] },
    cwd: '/test/project',
    interactive: true,
    ...overrides,
  };
}

describe('spell schedule command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnsureDaemon.mockResolvedValue({
      daemonRunning: true,
      daemonInstalled: true,
      warnings: [],
    });
  });

  // ── Structure ─────────────────────────────────────────────────────────────

  it('should have create, list, executions, and cancel subcommands', () => {
    const names = scheduleCommand.subcommands!.map(c => c.name);
    expect(names).toContain('create');
    expect(names).toContain('list');
    expect(names).toContain('executions');
    expect(names).toContain('cancel');
  });

  // ── Create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    const createCmd = () => findSub('create');

    it('should create a schedule with --cron', async () => {
      mockCallMCP.mockResolvedValue({});

      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', cron: '0 9 * * *' },
      })) as CommandResult;

      expect(result.success).toBe(true);
      expect(mockCallMCP).toHaveBeenCalledWith('memory_store', expect.objectContaining({
        namespace: 'scheduled-spells',
      }));
      expect(mockEnsureDaemon).toHaveBeenCalled();
    });

    it('should create a schedule with --interval', async () => {
      mockCallMCP.mockResolvedValue({});

      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'check', interval: '6h' },
      })) as CommandResult;

      expect(result.success).toBe(true);
    });

    it('should create a schedule with --at', async () => {
      mockCallMCP.mockResolvedValue({});

      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'report', at: '2026-04-01T09:00:00Z' },
      })) as CommandResult;

      expect(result.success).toBe(true);
    });

    it('should error when no timing option provided', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit' },
      })) as CommandResult;

      expect(result.success).toBe(false);
    });

    it('should error when multiple timing options provided', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', cron: '0 9 * * *', interval: '6h' },
      })) as CommandResult;

      expect(result.success).toBe(false);
    });

    it('should error when no name provided', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], cron: '0 9 * * *' },
      })) as CommandResult;

      expect(result.success).toBe(false);
    });

    it('should reject invalid cron expression', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', cron: 'invalid' },
      })) as CommandResult;

      expect(result.success).toBe(false);
    });

    // Issue #756: if this fails, the fixed-depth-import regression is back —
    // the strict cron-parser is no longer loading and validation has fallen
    // through to the old permissive shape-only check.
    it('should reject 5-field garbage cron via strict parser', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', cron: 'a b c d e' },
      })) as CommandResult;

      expect(result.success).toBe(false);
      // mcp_memory_store must NOT have been called for an invalid cron.
      expect(mockCallMCP).not.toHaveBeenCalled();
    });

    it('should reject invalid interval format', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', interval: 'bad' },
      })) as CommandResult;

      expect(result.success).toBe(false);
    });

    it('should reject invalid datetime', async () => {
      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', at: 'not-a-date' },
      })) as CommandResult;

      expect(result.success).toBe(false);
    });

    it('should still create schedule when daemon is not running', async () => {
      mockEnsureDaemon.mockResolvedValue({
        daemonRunning: false,
        daemonInstalled: false,
        warnings: ['Daemon is not running.'],
      });
      mockCallMCP.mockResolvedValue({});

      const result = await createCmd().action!(makeCtx({
        flags: { _: [], name: 'audit', cron: '0 9 * * *' },
      })) as CommandResult;

      // Schedule is always created regardless of daemon state
      expect(result.success).toBe(true);
      expect(mockCallMCP).toHaveBeenCalledWith('memory_store', expect.anything());
    });
  });

  // ── List ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    const listCmd = () => findSub('list');

    it('should list schedules', async () => {
      const scheduleValue = {
        id: 'sched-adhoc-123',
        spellName: 'audit',
        cron: '0 9 * * *',
        nextRunAt: Date.now() + 60000,
        enabled: true,
      };
      mockCallMCP
        .mockResolvedValueOnce({ entries: [{ key: 'sched-adhoc-123', namespace: 'scheduled-spells' }] })
        .mockResolvedValueOnce({ value: scheduleValue, found: true });

      const result = await listCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
      expect(mockCallMCP).toHaveBeenNthCalledWith(1, 'memory_list', expect.objectContaining({
        namespace: 'scheduled-spells',
      }));
      expect(mockCallMCP).toHaveBeenNthCalledWith(2, 'memory_retrieve', expect.objectContaining({
        namespace: 'scheduled-spells',
        key: 'sched-adhoc-123',
      }));
      const data = result.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('sched-adhoc-123');
    });

    it('should show empty message when no schedules', async () => {
      mockCallMCP.mockResolvedValue({ entries: [] });

      const result = await listCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
    });
  });

  // ── Executions ────────────────────────────────────────────────────────────

  describe('executions', () => {
    const execCmd = () => findSub('executions');

    function makeExec(overrides: Record<string, unknown> = {}) {
      return {
        id: 'exec-sched-1-1700000000000',
        scheduleId: 'sched-1',
        spellName: 'audit',
        startedAt: 1700000000000,
        completedAt: 1700000001000,
        success: true,
        spellId: 'spell-1',
        duration: 1000,
        ...overrides,
      };
    }

    function mockNamespaceFetch(values: Record<string, unknown>[]) {
      mockCallMCP.mockImplementation(async (tool: string, input: Record<string, unknown>) => {
        if (tool === 'memory_list') {
          return {
            entries: values.map(v => ({ key: String(v.id), namespace: input.namespace as string })),
          };
        }
        if (tool === 'memory_retrieve') {
          const value = values.find(v => v.id === input.key);
          return { value, found: value !== undefined };
        }
        return {};
      });
    }

    it('shows empty message when no executions exist', async () => {
      mockCallMCP.mockResolvedValue({ entries: [] });

      const result = await execCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
      expect(mockCallMCP).toHaveBeenCalledWith('memory_list', expect.objectContaining({
        namespace: 'schedule-executions',
      }));
    });

    it('lists all executions sorted by startedAt desc', async () => {
      mockNamespaceFetch([
        makeExec({ id: 'exec-old', startedAt: 1700000000000 }),
        makeExec({ id: 'exec-new', startedAt: 1700000060000 }),
      ]);

      const result = await execCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
      const data = result.data as Array<{ id: string }>;
      expect(data[0].id).toBe('exec-new');
      expect(data[1].id).toBe('exec-old');
    });

    it('filters by --schedule', async () => {
      mockNamespaceFetch([
        makeExec({ id: 'a', scheduleId: 'sched-1' }),
        makeExec({ id: 'b', scheduleId: 'sched-2' }),
      ]);

      const result = await execCmd().action!(makeCtx({
        flags: { _: [], schedule: 'sched-2' },
      })) as CommandResult;
      const data = result.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('b');
    });

    it('truncates to --limit', async () => {
      mockNamespaceFetch(
        Array.from({ length: 5 }, (_, i) => makeExec({ id: `e${i}`, startedAt: 1700000000000 + i })),
      );

      const result = await execCmd().action!(makeCtx({
        flags: { _: [], limit: 2 },
      })) as CommandResult;
      const data = result.data as unknown[];
      expect(data).toHaveLength(2);
    });

    it('defaults to limit 10', async () => {
      mockNamespaceFetch(
        Array.from({ length: 15 }, (_, i) => makeExec({ id: `e${i}`, startedAt: 1700000000000 + i })),
      );

      const result = await execCmd().action!(makeCtx()) as CommandResult;
      const data = result.data as unknown[];
      expect(data).toHaveLength(10);
    });

    it('drops records missing startedAt', async () => {
      mockNamespaceFetch([
        makeExec({ id: 'good' }),
        { id: 'no-startedAt' },
      ]);

      const result = await execCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
      const data = result.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('good');
    });

    it('returns raw execution objects when --format json', async () => {
      const exec = makeExec({ id: 'a' });
      mockNamespaceFetch([exec]);

      const result = await execCmd().action!(makeCtx({
        flags: { _: [], format: 'json' },
      })) as CommandResult;
      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        id: 'a',
        scheduleId: 'sched-1',
        spellName: 'audit',
        success: true,
        duration: 1000,
      });
    });

    it('returns success with empty data when MCP returns no entries', async () => {
      mockCallMCP.mockResolvedValue({});

      const result = await execCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  // ── Cancel ────────────────────────────────────────────────────────────────

  describe('cancel', () => {
    const cancelCmd = () => findSub('cancel');

    it('should cancel a schedule by ID', async () => {
      mockCallMCP.mockResolvedValueOnce({
        value: JSON.stringify({
          id: 'sched-adhoc-123',
          spellName: 'audit',
          enabled: true,
        }),
      }).mockResolvedValueOnce({});

      const result = await cancelCmd().action!(makeCtx({
        args: ['sched-adhoc-123'],
      })) as CommandResult;

      expect(result.success).toBe(true);
      // Second call should write the updated (disabled) record
      expect(mockCallMCP).toHaveBeenCalledTimes(2);
    });

    it('should error when schedule ID not provided', async () => {
      const result = await cancelCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(false);
    });

    it('should error when schedule not found', async () => {
      mockCallMCP.mockResolvedValue({ value: null });

      const result = await cancelCmd().action!(makeCtx({
        args: ['nonexistent-id'],
      })) as CommandResult;

      expect(result.success).toBe(false);
    });
  });
});
