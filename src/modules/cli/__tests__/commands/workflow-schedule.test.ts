/**
 * Workflow Schedule Command Tests
 *
 * Tests the schedule subcommand: create, list, cancel.
 * Mocks MCP tools and daemon readiness for isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext, CommandResult } from '../../src/types.js';

// Mock MCP client
vi.mock('../../src/mcp-client.js', () => ({
  callMCPTool: vi.fn(),
  MCPClientError: class MCPClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MCPClientError';
    }
  },
}));

// Mock daemon readiness
vi.mock('../../src/services/daemon-readiness.js', () => ({
  ensureDaemonForScheduling: vi.fn(),
}));

// Mock output (suppress console output in tests)
vi.mock('../../src/output.js', () => {
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

import { callMCPTool } from '../../src/mcp-client.js';
import { ensureDaemonForScheduling } from '../../src/services/daemon-readiness.js';
import { scheduleCommand } from '../../src/commands/workflow-schedule.js';

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

describe('workflow schedule command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnsureDaemon.mockResolvedValue({
      daemonRunning: true,
      daemonInstalled: true,
      warnings: [],
    });
  });

  // ── Structure ─────────────────────────────────────────────────────────────

  it('should have create, list, and cancel subcommands', () => {
    const names = scheduleCommand.subcommands!.map(c => c.name);
    expect(names).toContain('create');
    expect(names).toContain('list');
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
        namespace: 'scheduled-workflows',
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
      mockCallMCP.mockResolvedValue({
        results: [
          {
            key: 'sched-adhoc-123',
            value: JSON.stringify({
              id: 'sched-adhoc-123',
              workflowName: 'audit',
              cron: '0 9 * * *',
              nextRunAt: Date.now() + 60000,
              enabled: true,
            }),
          },
        ],
      });

      const result = await listCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
      expect(mockCallMCP).toHaveBeenCalledWith('memory_list', expect.objectContaining({
        namespace: 'scheduled-workflows',
      }));
    });

    it('should show empty message when no schedules', async () => {
      mockCallMCP.mockResolvedValue({ results: [] });

      const result = await listCmd().action!(makeCtx()) as CommandResult;
      expect(result.success).toBe(true);
    });
  });

  // ── Cancel ────────────────────────────────────────────────────────────────

  describe('cancel', () => {
    const cancelCmd = () => findSub('cancel');

    it('should cancel a schedule by ID', async () => {
      mockCallMCP.mockResolvedValueOnce({
        value: JSON.stringify({
          id: 'sched-adhoc-123',
          workflowName: 'audit',
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
