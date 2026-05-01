/**
 * System E2E: bootstrap directive parity.
 *
 * Verifies the canonical memory-first directive in
 * `.claude/helpers/subagent-bootstrap.json` flows byte-for-byte through every
 * spawn surface — the cjs SubagentStart hook, `agent_spawn`, and
 * `hive-mind_spawn`. Drift between any two surfaces would let a subagent
 * bootstrap without the memory-first instruction.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { _resetSwarmCoordinatorForTest } from '../../src/cli/mcp-tools/swarm-coordinator-singleton.js';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../../src/cli/services/subagent-bootstrap.js';
import { locateMofloRootPath } from '../../src/cli/services/moflo-require.js';
import {
  getAgentTool,
  getHiveMindTool,
} from '../../src/cli/__tests__/mcp-tools/_helpers.js';

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

function runHook(): HookOutput {
  const hookPath = locateMofloRootPath('.claude/helpers/subagent-start.cjs');
  if (!hookPath) throw new Error('subagent-start.cjs not found in moflo package root');
  const stdout = execFileSync('node', [hookPath], {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout) as HookOutput;
}

describe('System E2E — subagent bootstrap directive parity', () => {
  let hookOutput: HookOutput;

  beforeAll(() => {
    expect(SUBAGENT_BOOTSTRAP_DIRECTIVE.length).toBeGreaterThan(0);
    // Cached once: node cold-start is ~150–300ms per spawn.
    hookOutput = runHook();
  });

  afterEach(async () => {
    try {
      await getHiveMindTool('hive-mind_shutdown').handler({ force: true });
    } catch {
      // hive may not be initialized in agent-only tests
    }
    await _resetSwarmCoordinatorForTest();
  });

  it('SubagentStart hook emits additionalContext byte-for-byte equal to the canonical directive', () => {
    expect(hookOutput.hookSpecificOutput?.hookEventName).toBe('SubagentStart');
    expect(hookOutput.hookSpecificOutput?.additionalContext).toBe(SUBAGENT_BOOTSTRAP_DIRECTIVE);
  });

  it('agent_spawn injects the canonical directive into the MCP response', async () => {
    const result = (await getAgentTool('agent_spawn').handler({
      agentType: 'coder',
    })) as SpawnAgentResult;

    expect(result.success).toBe(true);
    expect(result.bootstrap).toBe(SUBAGENT_BOOTSTRAP_DIRECTIVE);
  });

  it('hive-mind_spawn injects the canonical directive into every spawned worker', async () => {
    await getHiveMindTool('hive-mind_init').handler({ topology: 'mesh' });

    const result = (await getHiveMindTool('hive-mind_spawn').handler({
      count: 3,
      role: 'worker',
      agentType: 'worker',
    })) as HiveSpawnResult;

    expect(result.success).toBe(true);
    expect(result.workers).toHaveLength(3);
    for (const worker of result.workers) {
      expect(worker.bootstrap, `worker ${worker.agentId}`).toBe(SUBAGENT_BOOTSTRAP_DIRECTIVE);
    }
  });

  it('all spawn surfaces share one canonical string (no fork allowed)', async () => {
    await getHiveMindTool('hive-mind_init').handler({ topology: 'mesh' });

    const agentResult = (await getAgentTool('agent_spawn').handler({
      agentType: 'tester',
    })) as SpawnAgentResult;

    const hiveResult = (await getHiveMindTool('hive-mind_spawn').handler({
      count: 1,
      agentType: 'worker',
    })) as HiveSpawnResult;

    const allDirectives = new Set([
      SUBAGENT_BOOTSTRAP_DIRECTIVE,
      hookOutput.hookSpecificOutput?.additionalContext,
      agentResult.bootstrap,
      ...hiveResult.workers.map(w => w.bootstrap),
    ]);
    expect(allDirectives.size).toBe(1);
  });
});
