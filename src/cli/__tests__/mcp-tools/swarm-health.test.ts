/**
 * `swarm_health` wired to the live UnifiedSwarmCoordinator (story #803).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getSwarmTool, spawnAgentForTest } from './_helpers.js';

interface HealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  swarmId: string;
  checks: Array<{ name: string; status: 'ok' | 'fail'; message: string }>;
  checkedAt: string;
}

async function callInit(input: Record<string, unknown> = {}) {
  return getSwarmTool('swarm_init').handler(input);
}

async function callHealth(input: Record<string, unknown> = {}): Promise<HealthResult> {
  return (await getSwarmTool('swarm_health').handler(input)) as HealthResult;
}

describe('swarm_health — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('returns healthy with all 4 checks ok on a fresh swarm', async () => {
    await callInit();
    const result = await callHealth();

    expect(result.status).toBe('healthy');
    expect(result.checks).toHaveLength(4);
    const names = result.checks.map(c => c.name).sort();
    expect(names).toEqual(['agents', 'coordinator', 'memory', 'messaging']);
    expect(result.checks.every(c => c.status === 'ok')).toBe(true);
  });

  it('flips to degraded when an agent has low health', async () => {
    await callInit();
    const agentId = await spawnAgentForTest({ agentType: 'coder' });

    // Mutate agent health below the 0.7 threshold to simulate a degraded agent.
    const coord = await getSwarmCoordinator();
    const agent = coord.getAgent(agentId);
    expect(agent).toBeDefined();
    agent!.health = 0.1;

    const result = await callHealth();
    expect(result.status).toBe('degraded');
    const agentsCheck = result.checks.find(c => c.name === 'agents');
    expect(agentsCheck?.status).toBe('fail');
    expect(agentsCheck?.message).toMatch(/degraded/);

    // Coordinator itself is still running, so other checks remain ok.
    const coordinatorCheck = result.checks.find(c => c.name === 'coordinator');
    expect(coordinatorCheck?.status).toBe('ok');
  });

  it('reports unhealthy when the coordinator is shut down', async () => {
    await callInit();
    const coord = await getSwarmCoordinator();
    await coord.shutdown();

    const result = await callHealth();
    expect(result.status).toBe('unhealthy');
    const coordinatorCheck = result.checks.find(c => c.name === 'coordinator');
    expect(coordinatorCheck?.status).toBe('fail');
    expect(coordinatorCheck?.message).toMatch(/stopped/);
  });

  it('passes swarmId through when caller supplies one', async () => {
    await callInit();
    const result = await callHealth({ swarmId: 'caller-supplied-id' });
    expect(result.swarmId).toBe('caller-supplied-id');
  });
});
