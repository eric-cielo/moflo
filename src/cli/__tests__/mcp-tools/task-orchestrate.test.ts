/**
 * `task_orchestrate` load-balanced multi-task distribution.
 *
 * Acceptance bar: "5 tasks across 3 agents → no agent gets more than 2."
 * That hinges on the coordinator's `assignTask` scoring heuristic
 * (workload-aware), not on this MCP shim. These tests pin the contract so
 * future scheduler refactors don't silently regress fairness.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getTaskTool, spawnAgentForTest } from './_helpers.js';

interface OrchestrateResult {
  success: boolean;
  submitted: number;
  assigned: number;
  queued: number;
  rejected: number;
  tasks: Array<{
    taskId: string;
    type: string;
    status: string;
    assignedTo: string[];
  }>;
  errors: Array<{ index: number; error: string }>;
}

const orchestrateTool = getTaskTool('task_orchestrate');

async function orchestrate(input: Record<string, unknown>): Promise<OrchestrateResult> {
  return (await orchestrateTool.handler(input)) as OrchestrateResult;
}

describe('task_orchestrate — load-balanced submission', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('5 tasks across 3 agents: no agent receives more than 2 — and tasks beyond capacity queue', async () => {
    // 3 worker agents — coordinator's `assignTask` will score-balance, picking
    // the lowest-workload idle agent on each new submit. Once an agent goes
    // 'busy' it falls out of `getAvailableAgents()`, so subsequent submits
    // must spread across remaining idle agents until all are busy, then queue.
    const agents = [
      await spawnAgentForTest({ agentType: 'coder' }),
      await spawnAgentForTest({ agentType: 'coder' }),
      await spawnAgentForTest({ agentType: 'coder' }),
    ];

    const result = await orchestrate({
      tasks: Array.from({ length: 5 }).map((_, i) => ({
        type: 'coding',
        description: `task-${i}`,
        priority: 'normal',
      })),
    });

    expect(result.submitted).toBe(5);
    expect(result.rejected).toBe(0);

    // Count tasks-per-agent across the FIRST assignment of each task.
    const counts = new Map<string, number>(agents.map(a => [a, 0]));
    for (const t of result.tasks) {
      if (t.assignedTo.length > 0) {
        const agent = t.assignedTo[0];
        counts.set(agent, (counts.get(agent) ?? 0) + 1);
      }
    }

    // Every assigned count must be ≤ 2 — that's the AC for no-agent-overload.
    for (const [agent, count] of counts) {
      expect(count, `agent ${agent} got ${count} tasks (max 2)`).toBeLessThanOrEqual(2);
    }

    // 3 agents × 1 concurrent task each = 3 assigned, 2 queued.
    expect(result.assigned).toBe(3);
    expect(result.queued).toBe(2);
  });

  it('honors per-task type/priority overrides without bleeding state', async () => {
    await spawnAgentForTest({ agentType: 'coder' });
    await spawnAgentForTest({ agentType: 'researcher' });

    const result = await orchestrate({
      tasks: [
        { type: 'coding', description: 'high-prio', priority: 'critical' },
        { type: 'research', description: 'normal', priority: 'normal' },
      ],
    });

    expect(result.submitted).toBe(2);
    expect(result.tasks[0].type).toBe('coding');
    expect(result.tasks[1].type).toBe('research');

    const coord = await getSwarmCoordinator();
    const live0 = coord.getTask(result.tasks[0].taskId);
    const live1 = coord.getTask(result.tasks[1].taskId);
    expect(live0?.priority).toBe('critical');
    expect(live1?.priority).toBe('normal');
  });

  it('rejects bad-shaped tasks individually and continues with valid ones', async () => {
    await spawnAgentForTest({ agentType: 'coder' });

    const result = await orchestrate({
      tasks: [
        { type: 'coding', description: 'good' },
        { type: 'sandwich', description: 'bad-type' },
        { description: 'no-type-at-all' },
        { type: 'coding', description: 'also-good' },
      ],
    });

    expect(result.submitted).toBe(2);
    expect(result.rejected).toBe(2);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[1].index).toBe(2);
    expect(result.success).toBe(false); // any rejection flips success
  });

  it('rejects empty or non-array tasks input', async () => {
    const empty = await orchestrate({ tasks: [] });
    expect(empty.success).toBe(false);

    const notArray = await orchestrate({ tasks: 'not-an-array' as unknown as object[] });
    expect(notArray.success).toBe(false);
  });

  it('persists every submitted task in the coordinator (not a JSON store)', async () => {
    await spawnAgentForTest({ agentType: 'coder' });

    const result = await orchestrate({
      tasks: [
        { type: 'coding', description: 'one' },
        { type: 'coding', description: 'two' },
      ],
    });
    expect(result.submitted).toBe(2);

    const coord = await getSwarmCoordinator();
    for (const t of result.tasks) {
      const live = coord.getTask(t.taskId);
      expect(live, `task ${t.taskId} should be persisted in coordinator`).toBeDefined();
    }
  });
});
