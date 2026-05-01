/**
 * `agent_list` wired to the live UnifiedSwarmCoordinator (story #802).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { _resetSwarmCoordinatorForTest } from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getAgentTool, spawnAgentForTest } from './_helpers.js';

interface ListResult {
  agents: Array<{
    agentId: string;
    name: string;
    agentType: string;
    status: string;
    domain?: string;
    workload: number;
    health: number;
  }>;
  total: number;
  returned: number;
  filters: Record<string, unknown>;
}

const listTool = getAgentTool('agent_list');
const terminateTool = getAgentTool('agent_terminate');

async function list(input: Record<string, unknown> = {}): Promise<ListResult> {
  return (await listTool.handler(input)) as ListResult;
}

describe('agent_list — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('reflects agents spawned through the coordinator', async () => {
    const a1 = await spawnAgentForTest({ agentType: 'coder' });
    const a2 = await spawnAgentForTest({ agentType: 'tester' });

    const result = await list();
    const ids = result.agents.map(a => a.agentId);
    expect(ids).toContain(a1);
    expect(ids).toContain(a2);
    expect(result.total).toBe(result.agents.length);
  });

  it('returns an empty array when no agents exist', async () => {
    const result = await list();
    expect(result.agents).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('filters by agentType', async () => {
    await spawnAgentForTest({ agentType: 'coder' });
    await spawnAgentForTest({ agentType: 'coder' });
    await spawnAgentForTest({ agentType: 'tester' });

    const result = await list({ agentType: 'coder' });
    expect(result.agents.length).toBe(2);
    expect(result.agents.every(a => a.agentType === 'coder')).toBe(true);
  });

  it('filters by status', async () => {
    await spawnAgentForTest({ agentType: 'coder' });
    const idle = await list({ status: 'idle' });
    expect(idle.agents.length).toBeGreaterThanOrEqual(1);
    expect(idle.agents.every(a => a.status === 'idle')).toBe(true);

    const busy = await list({ status: 'busy' });
    expect(busy.agents).toEqual([]);
  });

  it('honors limit and offset for pagination', async () => {
    for (let i = 0; i < 5; i++) await spawnAgentForTest({ agentType: 'worker' });

    const page1 = await list({ limit: 2, offset: 0 });
    expect(page1.agents.length).toBe(2);
    expect(page1.total).toBe(5);
    expect(page1.returned).toBe(2);

    const page2 = await list({ limit: 2, offset: 2 });
    expect(page2.agents.length).toBe(2);

    const page3 = await list({ limit: 2, offset: 4 });
    expect(page3.agents.length).toBe(1);

    const ids = new Set([
      ...page1.agents.map(a => a.agentId),
      ...page2.agents.map(a => a.agentId),
      ...page3.agents.map(a => a.agentId),
    ]);
    expect(ids.size).toBe(5);
  });

  it('does not surface terminated agents (coordinator deletes them)', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'coder' });
    await terminateTool.handler({ agentId });

    const result = await list();
    expect(result.agents.find(a => a.agentId === agentId)).toBeUndefined();
  });
});
