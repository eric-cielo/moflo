/**
 * `flo memory cleanup` reports the durable rows the exemption withheld (#1464).
 *
 * The number matters more than it looks. Durable namespaces are skipped by the
 * age-based buckets, so a store full of ancient learnings reports zero
 * candidates — and an operator reads that as "learnings are already tidy" when
 * the truth is "learnings were never examined". Printing the held-back count is
 * what keeps the clean result honest, so it gets a test rather than resting on
 * the MCP field being populated.
 *
 * The MCP call is mocked: what is under test here is the command's rendering of
 * the result, not the handler that produces it — that half is covered by
 * `mcp-tools/memory-cleanup-durable-exemption-1464.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  calls: [] as Array<{ tool: string; args: unknown }>,
}));

vi.mock('../../mcp-client.js', () => ({
  callMCPTool: (tool: string, args: unknown) => {
    hoisted.calls.push({ tool, args });
    return Promise.resolve(hoisted.result);
  },
  MCPClientError: class MCPClientError extends Error {},
}));

import { memoryCommand } from '../../commands/memory.js';
import { output } from '../../output.js';
import type { Command, CommandContext } from '../../types.js';

const cleanup = memoryCommand.subcommands!.find(c => c.name === 'cleanup') as Command;

afterEach(() => vi.restoreAllMocks());

function cleanupResult(overrides: Record<string, unknown> = {}) {
  return {
    dryRun: true,
    candidates: { expired: 0, stale: 0, lowQuality: 0, total: 0 },
    deleted: { entries: 0 },
    freed: { bytes: 0, formatted: '0 B' },
    duration: 1,
    ...overrides,
  };
}

/** Runs the command and returns everything it printed, in order. */
async function run(result: Record<string, unknown>): Promise<string[]> {
  hoisted.result = result;
  hoisted.calls = [];
  const lines: string[] = [];
  const record = (v: unknown) => { lines.push(String(v)); };
  vi.spyOn(output, 'printInfo').mockImplementation(record);
  vi.spyOn(output, 'printSuccess').mockImplementation(record);
  vi.spyOn(output, 'printWarning').mockImplementation(record);
  vi.spyOn(output, 'writeln').mockImplementation((v?: unknown) => { if (v != null) lines.push(String(v)); });
  vi.spyOn(output, 'printList').mockImplementation((items: string[]) => { lines.push(...items); });
  vi.spyOn(output, 'printTable').mockImplementation(() => { /* rendering is not under test */ });

  const ctx: CommandContext = {
    args: [], flags: { _: [], dryRun: true, olderThan: '1d' }, cwd: process.cwd(), interactive: false,
  };
  await cleanup.action!(ctx);
  return lines;
}

describe('flo memory cleanup — held-back reporting (#1464)', () => {
  it('states how many durable entries were held back', async () => {
    const lines = await run(cleanupResult({ durableHeldBack: 3 }));

    const held = lines.find(l => l.includes('held back'));
    expect(held).toBeDefined();
    expect(held).toContain('3 durable entries');
    // And it must say what to do about it, or the number is just a puzzle.
    expect(lines.some(l => l.includes('--namespace learnings'))).toBe(true);
  });

  it('uses the singular for one entry', async () => {
    const lines = await run(cleanupResult({ durableHeldBack: 1 }));
    expect(lines.find(l => l.includes('held back'))).toContain('1 durable entry');
  });

  it('says nothing when nothing was held back', async () => {
    const lines = await run(cleanupResult({ durableHeldBack: 0 }));
    expect(lines.some(l => l.includes('held back'))).toBe(false);
  });

  it('says nothing against an older server that never sends the field', async () => {
    // The CLI ships independently of the MCP server a consumer may still be
    // running; an absent field must render as "none", never "undefined".
    const lines = await run(cleanupResult());
    expect(lines.some(l => l.includes('held back'))).toBe(false);
    expect(lines.some(l => l.includes('undefined'))).toBe(false);
  });
});
