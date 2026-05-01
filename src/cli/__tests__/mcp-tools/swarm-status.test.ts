/**
 * `swarm_status` wired to the live UnifiedSwarmCoordinator (story #803).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { _resetSwarmCoordinatorForTest } from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getSwarmTool, spawnAgentForTest } from './_helpers.js';

interface StatusResult {
  swarmId: string;
  status: string;
  topology: string;
  agentCount: number;
  taskCount: number;
  agents?: Array<{ agentId: string; agentType: string }>;
  metrics?: { activeAgents: number };
  topologyState?: { type: string };
}

async function callInit(input: Record<string, unknown> = {}) {
  return getSwarmTool('swarm_init').handler(input);
}

async function callStatus(input: Record<string, unknown> = {}): Promise<StatusResult> {
  return (await getSwarmTool('swarm_status').handler(input)) as StatusResult;
}

describe('swarm_status — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('reflects live agent count after agent_spawn (epic #798 end-to-end)', async () => {
    await callInit({ topology: 'mesh' });

    const before = await callStatus();
    expect(before.agentCount).toBe(0);
    expect(before.status).toBe('running');

    await spawnAgentForTest({ agentType: 'coder' });
    await spawnAgentForTest({ agentType: 'researcher' });

    const after = await callStatus();
    expect(after.agentCount).toBe(2);
    expect(after.swarmId).toBe(before.swarmId);
  });

  it('omits agents/metrics/topologyState by default', async () => {
    await callInit();
    const result = await callStatus();
    expect(result.agents).toBeUndefined();
    expect(result.metrics).toBeUndefined();
    expect(result.topologyState).toBeUndefined();
  });

  it('honors includeAgents — returns live agent list from coordinator', async () => {
    await callInit();
    await spawnAgentForTest({ agentType: 'tester' });
    const result = await callStatus({ includeAgents: true });
    expect(result.agents).toBeDefined();
    expect(result.agents!.length).toBe(1);
    expect(result.agents![0].agentType).toBe('tester');
  });

  it('honors includeMetrics — returns CoordinatorMetrics', async () => {
    await callInit();
    const result = await callStatus({ includeMetrics: true });
    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics!.activeAgents).toBe('number');
  });

  it('honors includeTopology — returns topology state', async () => {
    await callInit({ topology: 'mesh' });
    const result = await callStatus({ includeTopology: true });
    expect(result.topologyState).toBeDefined();
    expect(result.topologyState!.type).toBe('mesh');
  });
});
