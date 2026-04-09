/**
 * MCP Tool Name Constants Tests
 *
 * Story #380: Validates tool name constants match expected values
 * and that command files use constants instead of string literals.
 * Story #371: Renamed workflow tool constants to spell_* names.
 */

import { describe, it, expect } from 'vitest';
import * as toolNames from '../src/mcp-tools/tool-names.js';

describe('MCP Tool Name Constants', () => {
  it('exports spell tool names', () => {
    expect(toolNames.TOOL_SPELL_CAST).toBe('spell_cast');
    expect(toolNames.TOOL_SPELL_LIST).toBe('spell_list');
    expect(toolNames.TOOL_SPELL_STATUS).toBe('spell_status');
    expect(toolNames.TOOL_SPELL_CANCEL).toBe('spell_cancel');
    expect(toolNames.TOOL_SPELL_TEMPLATE).toBe('spell_template');
  });

  it('exports memory tool names', () => {
    expect(toolNames.TOOL_MEMORY_STORE).toBe('memory_store');
    expect(toolNames.TOOL_MEMORY_RETRIEVE).toBe('memory_retrieve');
    expect(toolNames.TOOL_MEMORY_LIST).toBe('memory_list');
    expect(toolNames.TOOL_MEMORY_STATS).toBe('memory_stats');
  });

  it('exports session tool names', () => {
    expect(toolNames.TOOL_SESSION_CURRENT).toBe('session_current');
  });

  it('exports progress tool names', () => {
    expect(toolNames.TOOL_PROGRESS_CHECK).toBe('progress_check');
    expect(toolNames.TOOL_PROGRESS_SUMMARY).toBe('progress_summary');
  });

  it('exports hive-mind tool names', () => {
    expect(toolNames.TOOL_HIVE_MIND_JOIN).toBe('hive-mind_join');
    expect(toolNames.TOOL_HIVE_MIND_LEAVE).toBe('hive-mind_leave');
    expect(toolNames.TOOL_HIVE_MIND_CONSENSUS).toBe('hive-mind_consensus');
    expect(toolNames.TOOL_HIVE_MIND_BROADCAST).toBe('hive-mind_broadcast');
    expect(toolNames.TOOL_HIVE_MIND_MEMORY).toBe('hive-mind_memory');
  });

  it('exports infrastructure tool names', () => {
    expect(toolNames.TOOL_MCP_STOP).toBe('mcp_stop');
    expect(toolNames.TOOL_SWARM_STOP).toBe('swarm_stop');
  });

  it('all exports are strings', () => {
    for (const [key, value] of Object.entries(toolNames)) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('spell.ts uses tool name constants (no string literals)', () => {
  it('spell.ts imports from tool-names.ts, not raw strings', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/commands/spell.ts'),
      'utf-8',
    );
    // Should import from tool-names
    expect(source).toContain("from '../mcp-tools/tool-names.js'");
    // Should NOT have raw string tool calls with old workflow_* names
    expect(source).not.toContain("callMCPTool<SpellRunResponse>('spell_cast'");
    expect(source).not.toContain("callMCPTool<SpellListResponse>('spell_list'");
    expect(source).not.toContain("callMCPTool<SpellStatusResponse>('spell_status'");
    expect(source).not.toContain("callMCPTool<SpellCancelResponse>('spell_cancel'");
    // Should use TOOL_SPELL_ constants instead
    expect(source).toContain('TOOL_SPELL_CAST');
    expect(source).toContain('TOOL_SPELL_LIST');
    expect(source).toContain('TOOL_SPELL_STATUS');
    expect(source).toContain('TOOL_SPELL_CANCEL');
    expect(source).toContain('TOOL_SPELL_TEMPLATE');
  });

  it('spell-schedule.ts imports from tool-names.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/commands/spell-schedule.ts'),
      'utf-8',
    );
    expect(source).toContain("from '../mcp-tools/tool-names.js'");
    expect(source).not.toContain("callMCPTool('memory_store'");
    expect(source).not.toContain("callMCPTool('memory_list'");
    expect(source).not.toContain("callMCPTool<{ value: string | null }>('memory_retrieve'");
    expect(source).toContain('TOOL_MEMORY_STORE');
    expect(source).toContain('TOOL_MEMORY_LIST');
    expect(source).toContain('TOOL_MEMORY_RETRIEVE');
  });
});

describe('command files use shared formatStatus', () => {
  const commandFiles = [
    'spell.ts',
    'task.ts',
    'session.ts',
    'agent.ts',
    'hooks.ts',
  ];

  for (const file of commandFiles) {
    it(`${file} imports formatStatus from cli-formatters`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const source = readFileSync(
        resolve(import.meta.dirname, '../src/commands', file),
        'utf-8',
      );
      expect(source).toContain("from '../services/cli-formatters.js'");
    });

    it(`${file} has no local formatStatus/formatStageStatus/formatWorkerStatus/formatHealthStatus function`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const source = readFileSync(
        resolve(import.meta.dirname, '../src/commands', file),
        'utf-8',
      );
      // Should not define its own status formatting functions
      expect(source).not.toMatch(/^function format(Stage)?Status\(/m);
      expect(source).not.toMatch(/^function formatWorkerStatus\(/m);
      expect(source).not.toMatch(/^function formatHealthStatus\(/m);
    });
  }
});
