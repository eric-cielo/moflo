/**
 * System E2E: bootstrap directive parity (epic #798, story #808).
 *
 * Story #800 made `.claude/helpers/subagent-bootstrap.json` the single source
 * of truth for the memory-first directive. Stories #801 / #807 then injected
 * that directive into every agent_spawn / hive-mind_spawn surface so spawned
 * subagents bootstrap with the same instruction the cjs SubagentStart hook
 * already injected.
 *
 * The unit-level parity is pinned in `tests/bin/subagent-start.test.ts` (cjs
 * hook ↔ JSON ↔ TS fallback). This system test cross-validates the same
 * canonical string flows out of the *MCP tool* surfaces — agent_spawn and
 * hive-mind_spawn — byte-for-byte.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentTools } from '../../src/cli/mcp-tools/agent-tools.js';
import { hiveMindTools } from '../../src/cli/mcp-tools/hive-mind-tools.js';
import { _resetSwarmCoordinatorForTest } from '../../src/cli/mcp-tools/swarm-coordinator-singleton.js';

const REPO_ROOT = resolve(__dirname, '../..');
const JSON_PATH = resolve(REPO_ROOT, '.claude/helpers/subagent-bootstrap.json');
const HOOK_PATH = resolve(REPO_ROOT, '.claude/helpers/subagent-start.cjs');

function tool<T extends { name: string; handler: (input: Record<string, unknown>) => Promise<unknown> }>(
  set: readonly T[],
  name: string,
): T {
  const found = set.find(t => t.name === name);
  if (!found) throw new Error(`tool "${name}" not registered`);
  return found;
}

interface SpawnAgentResult {
  success: boolean;
  agentId: string;
  bootstrap: string;
}

interface HiveSpawnResult {
  success: boolean;
  spawned: number;
  workers: Array<{ agentId: string; role: string; bootstrap: string }>;
}

interface HookOutput {
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
}

describe('System E2E — subagent bootstrap directive parity (story #800 + #801 + #807)', () => {
  let canonicalDirective: string;

  beforeAll(() => {
    canonicalDirective = (
      JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as { directive: string }
    ).directive;
    expect(canonicalDirective.length).toBeGreaterThan(0);
  });

  afterEach(async () => {
    try {
      await tool(hiveMindTools, 'hive-mind_shutdown').handler({ force: true });
    } catch {
      // ignored — hive may not be initialized in agent-only tests
    }
    await _resetSwarmCoordinatorForTest();
  });

  it('SubagentStart hook emits additionalContext byte-for-byte equal to the JSON', () => {
    const stdout = execFileSync('node', [HOOK_PATH], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = JSON.parse(stdout) as HookOutput;
    expect(output.hookSpecificOutput?.hookEventName).toBe('SubagentStart');
    expect(output.hookSpecificOutput?.additionalContext).toBe(canonicalDirective);
  });

  it('agent_spawn injects the canonical directive into the MCP response', async () => {
    const result = (await tool(agentTools, 'agent_spawn').handler({
      agentType: 'coder',
    })) as SpawnAgentResult;

    expect(result.success).toBe(true);
    expect(result.bootstrap).toBe(canonicalDirective);
  });

  it('hive-mind_spawn injects the canonical directive into every spawned worker (#807)', async () => {
    await tool(hiveMindTools, 'hive-mind_init').handler({ topology: 'mesh' });

    const result = (await tool(hiveMindTools, 'hive-mind_spawn').handler({
      count: 3,
      role: 'worker',
      agentType: 'worker',
    })) as HiveSpawnResult;

    expect(result.success).toBe(true);
    expect(result.workers).toHaveLength(3);
    for (const worker of result.workers) {
      expect(worker.bootstrap, `worker ${worker.agentId}`).toBe(canonicalDirective);
    }
  });

  it('all spawn surfaces share one canonical string (no fork allowed)', async () => {
    await tool(hiveMindTools, 'hive-mind_init').handler({ topology: 'mesh' });

    const hookStdout = execFileSync('node', [HOOK_PATH], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const hookDirective = (JSON.parse(hookStdout) as HookOutput).hookSpecificOutput?.additionalContext;

    const agentResult = (await tool(agentTools, 'agent_spawn').handler({
      agentType: 'tester',
    })) as SpawnAgentResult;

    const hiveResult = (await tool(hiveMindTools, 'hive-mind_spawn').handler({
      count: 1,
      agentType: 'worker',
    })) as HiveSpawnResult;

    // Every surface — JSON, hook, agent_spawn, hive-mind_spawn — emits the
    // same string. A drift here would mean a subagent bootstrap from one
    // surface differs from another, breaking memory-first enforcement.
    const allDirectives = new Set([
      canonicalDirective,
      hookDirective,
      agentResult.bootstrap,
      ...hiveResult.workers.map(w => w.bootstrap),
    ]);
    expect(allDirectives.size).toBe(1);
  });
});
