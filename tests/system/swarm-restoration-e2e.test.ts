/**
 * System E2E: swarm restoration end-to-end (epic #798, story #808).
 *
 * Drives the swarm/agent/task MCP surface through a full lifecycle to prove
 * the wired path from stories #799–#807 holds together as one system, not
 * just per-handler. This is the cap test for the epic — if any story's wiring
 * regresses to a stub, this is where it shows up.
 *
 * Coverage:
 *   1. swarm_init → agent_spawn × 3 → task_orchestrate × 5
 *      Load-balanced distribution: no agent gets > 2 of the 5 tasks.
 *   2. swarm_status reflects live agent + task counts (not literal `0/0`).
 *   3. agent_terminate one → swarm_status drops it from `agentSummary`.
 *   4. MCP-server-restart smoke: spawn 2 → reset singleton → agent_list still
 *      returns both via persistence hydration (story #806 verified at the
 *      system layer rather than the persistence-unit layer).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTools } from '../../src/cli/mcp-tools/agent-tools.js';
import { swarmTools } from '../../src/cli/mcp-tools/swarm-tools.js';
import { taskTools } from '../../src/cli/mcp-tools/task-tools.js';
import {
  _resetSwarmCoordinatorForTest,
  _setSwarmPersistenceForTest,
} from '../../src/cli/mcp-tools/swarm-coordinator-singleton.js';
import { SwarmPersistence } from '../../src/cli/swarm/swarm-persistence.js';
import { createInMemoryPersistence } from '../../src/cli/__tests__/swarm/_in-memory-persistence.js';

// ===== helpers =====

function tool<T extends { name: string; handler: (input: Record<string, unknown>) => Promise<unknown> }>(
  set: readonly T[],
  name: string,
): T {
  const found = set.find(t => t.name === name);
  if (!found) throw new Error(`tool "${name}" not registered`);
  return found;
}

interface SpawnResult {
  success: boolean;
  agentId: string;
}

interface OrchestrateResult {
  success: boolean;
  submitted: number;
  rejected: number;
  assigned: number;
  queued: number;
  tasks: Array<{ taskId: string; assignedTo: string[]; status: string }>;
}

interface StatusResult {
  swarmId: string;
  agentCount: number;
  taskCount: number;
  agentSummary: { total: number; active: number; idle: number; busy: number; terminated: number };
  status: string;
}

interface TerminateResult {
  success: boolean;
  terminated: boolean;
}

interface AgentListResult {
  agents: Array<{ agentId: string; agentType: string }>;
  total: number;
}

// ===== tests =====

describe('System E2E — swarm restoration (epic #798)', () => {
  afterEach(async () => {
    _setSwarmPersistenceForTest(null);
    await _resetSwarmCoordinatorForTest();
  });

  it('end-to-end: init → spawn × 3 → orchestrate × 5 → status reflects everything', async () => {
    const init = (await tool(swarmTools, 'swarm_init').handler({ topology: 'mesh' })) as {
      success: boolean;
      swarmId: string;
    };
    expect(init.success).toBe(true);
    expect(init.swarmId).toBeTruthy();

    const a1 = (await tool(agentTools, 'agent_spawn').handler({ agentType: 'coder' })) as SpawnResult;
    const a2 = (await tool(agentTools, 'agent_spawn').handler({ agentType: 'coder' })) as SpawnResult;
    const a3 = (await tool(agentTools, 'agent_spawn').handler({ agentType: 'coder' })) as SpawnResult;
    expect([a1.success, a2.success, a3.success]).toEqual([true, true, true]);
    const agentIds = [a1.agentId, a2.agentId, a3.agentId];

    const orchestrate = (await tool(taskTools, 'task_orchestrate').handler({
      tasks: Array.from({ length: 5 }).map((_, i) => ({
        type: 'coding',
        description: `task-${i}`,
        priority: 'normal',
      })),
    })) as OrchestrateResult;

    expect(orchestrate.submitted).toBe(5);
    expect(orchestrate.rejected).toBe(0);

    // Load balance AC: no agent gets > 2 of the 5 tasks. Coordinator's
    // `assignTask` picks lowest-workload idle agent; sequential submit in
    // task_orchestrate prevents the race that would let two submits observe
    // the same idle agent.
    const counts = new Map<string, number>(agentIds.map(id => [id, 0]));
    for (const task of orchestrate.tasks) {
      const owner = task.assignedTo[0];
      if (owner && counts.has(owner)) {
        counts.set(owner, counts.get(owner)! + 1);
      }
    }
    for (const [agent, count] of counts) {
      expect(count, `agent ${agent} got ${count} tasks (max 2)`).toBeLessThanOrEqual(2);
    }
    // 3 agents × 1 concurrent each = 3 assigned, 2 queued.
    expect(orchestrate.assigned).toBe(3);
    expect(orchestrate.queued).toBe(2);

    // swarm_status must reflect the live coordinator state, NOT a 0/0 stub.
    const status = (await tool(swarmTools, 'swarm_status').handler({})) as StatusResult;
    expect(status.swarmId).toBe(init.swarmId);
    expect(status.agentCount).toBe(3);
    expect(status.taskCount).toBe(5);
    expect(status.agentSummary.total).toBe(3);
    expect(status.status).toBe('running');
  });

  it('agent_terminate is reflected in swarm_status (no stub)', async () => {
    await tool(swarmTools, 'swarm_init').handler({ topology: 'mesh' });

    const a1 = (await tool(agentTools, 'agent_spawn').handler({ agentType: 'coder' })) as SpawnResult;
    const a2 = (await tool(agentTools, 'agent_spawn').handler({ agentType: 'coder' })) as SpawnResult;
    const a3 = (await tool(agentTools, 'agent_spawn').handler({ agentType: 'coder' })) as SpawnResult;

    const before = (await tool(swarmTools, 'swarm_status').handler({})) as StatusResult;
    expect(before.agentSummary.total).toBe(3);
    expect(before.agentCount).toBe(3);

    const term = (await tool(agentTools, 'agent_terminate').handler({
      agentId: a2.agentId,
      force: true,
      reason: 'system-test',
    })) as TerminateResult;
    expect(term.success).toBe(true);
    expect(term.terminated).toBe(true);

    // Coordinator removes terminated agents from `state.agents` (via
    // unregisterAgent) — they're gone, not held in a `terminated` row.
    // swarm_status reflects the live count drop.
    const after = (await tool(swarmTools, 'swarm_status').handler({})) as StatusResult;
    expect(after.agentSummary.total).toBe(2);
    expect(after.agentCount).toBe(2);
    expect(after.agentSummary.idle + after.agentSummary.busy).toBe(2);

    // Sanity: the surviving two agents are still listed.
    const list = (await tool(agentTools, 'agent_list').handler({
      status: 'idle',
    })) as AgentListResult;
    const survivors = list.agents.map(a => a.agentId).sort();
    expect(survivors).toEqual([a1.agentId, a3.agentId].sort());
  });

  describe('MCP-server restart smoke (story #806 cross-validation)', () => {
    let backend: ReturnType<typeof createInMemoryPersistence>;

    beforeEach(() => {
      backend = createInMemoryPersistence();
      _setSwarmPersistenceForTest(new SwarmPersistence(backend.fns));
    });

    it('spawn 2 → reset singleton → agent_list still returns both via hydration', async () => {
      const a1 = (await tool(agentTools, 'agent_spawn').handler({
        agentType: 'coder',
      })) as SpawnResult;
      const a2 = (await tool(agentTools, 'agent_spawn').handler({
        agentType: 'researcher',
      })) as SpawnResult;
      expect(a1.success).toBe(true);
      expect(a2.success).toBe(true);

      // Simulates MCP-server restart — the singleton's `_initPromise` is the
      // boundary between two coordinator processes for the persistence layer.
      await _resetSwarmCoordinatorForTest();

      const list = (await tool(agentTools, 'agent_list').handler({})) as AgentListResult;
      expect(list.total).toBe(2);
      const ids = list.agents.map(a => a.agentId).sort();
      expect(ids).toEqual([a1.agentId, a2.agentId].sort());
      const types = list.agents.map(a => a.agentType).sort();
      expect(types).toEqual(['coder', 'researcher']);
    });
  });
});
