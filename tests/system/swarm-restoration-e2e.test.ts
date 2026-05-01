/**
 * System E2E: swarm restoration end-to-end.
 *
 * Drives the swarm/agent/task MCP surface through a full lifecycle to prove
 * the wired path holds together as a system, not just per-handler. If any
 * MCP handler regresses to a stub, this is where it shows up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  _setSwarmPersistenceForTest,
} from '../../src/cli/mcp-tools/swarm-coordinator-singleton.js';
import { SwarmPersistence } from '../../src/cli/swarm/swarm-persistence.js';
import { createInMemoryPersistence } from '../../src/cli/__tests__/swarm/_in-memory-persistence.js';
import {
  getAgentTool,
  getSwarmTool,
  getTaskTool,
  spawnAgentForTest,
} from '../../src/cli/__tests__/mcp-tools/_helpers.js';
import { checkSwarmFunctional } from '../../src/cli/commands/doctor-checks-swarm.js';

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

describe('System E2E — swarm restoration', () => {
  afterEach(async () => {
    _setSwarmPersistenceForTest(null);
    await _resetSwarmCoordinatorForTest();
  });

  it('init → spawn × 3 → orchestrate × 5 → status reflects everything', async () => {
    const init = (await getSwarmTool('swarm_init').handler({ topology: 'mesh' })) as {
      success: boolean;
      swarmId: string;
    };
    expect(init.success).toBe(true);
    expect(init.swarmId).toBeTruthy();

    const agentIds = [
      await spawnAgentForTest({ agentType: 'coder' }),
      await spawnAgentForTest({ agentType: 'coder' }),
      await spawnAgentForTest({ agentType: 'coder' }),
    ];

    const orchestrate = (await getTaskTool('task_orchestrate').handler({
      tasks: Array.from({ length: 5 }, (_, i) => ({
        type: 'coding',
        description: `task-${i}`,
        priority: 'normal',
      })),
    })) as OrchestrateResult;

    expect(orchestrate.submitted).toBe(5);
    expect(orchestrate.rejected).toBe(0);

    // Coordinator's `assignTask` picks lowest-workload idle agent; sequential
    // submit in task_orchestrate prevents two submits from observing the same
    // idle agent. AC: no agent gets > 2 of the 5 tasks.
    const counts = new Map<string, number>(agentIds.map(id => [id, 0]));
    for (const task of orchestrate.tasks) {
      const owner = task.assignedTo[0];
      if (!owner) continue;
      const current = counts.get(owner);
      if (current === undefined) {
        expect.fail(`task ${task.taskId} assigned to unknown agent ${owner}`);
      }
      counts.set(owner, current + 1);
    }
    for (const [agent, count] of counts) {
      expect(count, `agent ${agent} got ${count} tasks (max 2)`).toBeLessThanOrEqual(2);
    }
    // 3 agents × 1 concurrent each = 3 assigned, 2 queued.
    expect(orchestrate.assigned).toBe(3);
    expect(orchestrate.queued).toBe(2);

    const status = (await getSwarmTool('swarm_status').handler({})) as StatusResult;
    expect(status.swarmId).toBe(init.swarmId);
    expect(status.agentCount).toBe(3);
    expect(status.taskCount).toBe(5);
    expect(status.agentSummary.total).toBe(3);
    expect(status.status).toBe('running');
  });

  it('agent_terminate is reflected in swarm_status', async () => {
    await getSwarmTool('swarm_init').handler({ topology: 'mesh' });

    const a1 = await spawnAgentForTest({ agentType: 'coder' });
    const a2 = await spawnAgentForTest({ agentType: 'coder' });
    const a3 = await spawnAgentForTest({ agentType: 'coder' });

    const before = (await getSwarmTool('swarm_status').handler({})) as StatusResult;
    expect(before.agentSummary.total).toBe(3);
    expect(before.agentCount).toBe(3);

    const term = (await getAgentTool('agent_terminate').handler({
      agentId: a2,
      force: true,
      reason: 'system-test',
    })) as TerminateResult;
    expect(term.success).toBe(true);
    expect(term.terminated).toBe(true);

    // Coordinator removes terminated agents from `state.agents` (via
    // unregisterAgent) — they're gone, not held in a `terminated` row.
    const after = (await getSwarmTool('swarm_status').handler({})) as StatusResult;
    expect(after.agentSummary.total).toBe(2);
    expect(after.agentCount).toBe(2);
    expect(after.agentSummary.idle + after.agentSummary.busy).toBe(2);

    const list = (await getAgentTool('agent_list').handler({
      status: 'idle',
    })) as AgentListResult;
    const survivors = list.agents.map(a => a.agentId).sort();
    expect(survivors).toEqual([a1, a3].sort());
  });

  // Issue #818: gate the regression that triggered epic #798. The doctor
  // check exercises the same MCP surface this file does — if a handler ever
  // gets disconnected from the coordinator again, this test fails before
  // ship, not after.
  describe('Doctor regression tripwire', () => {
    it('checkSwarmFunctional passes against the live coordinator', { timeout: 30_000 }, async () => {
      const result = await checkSwarmFunctional();
      // 'warn' is acceptable only when the dist isn't built — CI builds first
      // (consumer-install-smoke + main test job both run `npm run build`).
      if (result.status === 'warn' && /not built/i.test(result.message)) return;

      const failures = (result.details ?? []).filter(d => d.status === 'fail');
      expect(failures, `swarm doctor failures (epic #798 regression?): ${JSON.stringify(failures, null, 2)}`).toHaveLength(0);
      expect(result.status).toBe('pass');
    });
  });

  describe('MCP-server restart smoke', () => {
    let backend: ReturnType<typeof createInMemoryPersistence>;

    beforeEach(() => {
      backend = createInMemoryPersistence();
      _setSwarmPersistenceForTest(new SwarmPersistence(backend.fns));
    });

    it('spawn 2 → reset coordinator → agent_list returns both via persistence hydration', async () => {
      const a1 = await spawnAgentForTest({ agentType: 'coder' });
      const a2 = await spawnAgentForTest({ agentType: 'researcher' });

      // Singleton reset is the test analogue of an MCP-server restart.
      await _resetSwarmCoordinatorForTest();

      const list = (await getAgentTool('agent_list').handler({})) as AgentListResult;
      expect(list.total).toBe(2);
      const ids = list.agents.map(a => a.agentId).sort();
      expect(ids).toEqual([a1, a2].sort());
      const types = list.agents.map(a => a.agentType).sort();
      expect(types).toEqual(['coder', 'researcher']);
    });
  });
});
