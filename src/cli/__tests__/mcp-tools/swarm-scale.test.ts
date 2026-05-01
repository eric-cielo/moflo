/**
 * `swarm_scale` wired to the live UnifiedSwarmCoordinator (story #804).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getSwarmTool, spawnAgentForTest } from './_helpers.js';

interface ScaleResult {
  swarmId: string;
  previousAgents: number;
  targetAgents: number;
  currentAgents: number;
  scalingStatus: 'completed' | 'in-progress' | 'failed';
  scaleStrategy: 'gradual' | 'immediate' | 'adaptive';
  scaledAt: string;
  addedAgents?: string[];
  removedAgents?: string[];
  reason?: string;
  error?: string;
}

async function callInit(input: Record<string, unknown> = {}) {
  return getSwarmTool('swarm_init').handler(input);
}

async function callScale(input: Record<string, unknown>): Promise<ScaleResult> {
  return (await getSwarmTool('swarm_scale').handler(input)) as ScaleResult;
}

describe('swarm_scale — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('scales up from zero, calling coordinator.spawnAgent for each new agent', async () => {
    await callInit({ topology: 'mesh' });

    const result = await callScale({
      targetAgents: 3,
      scaleStrategy: 'immediate',
      agentTypes: ['worker'],
    });

    expect(result.scalingStatus).toBe('completed');
    expect(result.previousAgents).toBe(0);
    expect(result.currentAgents).toBe(3);
    expect(result.addedAgents).toBeDefined();
    expect(result.addedAgents!.length).toBe(3);
    expect(result.removedAgents).toBeUndefined();

    // All spawned agents are reachable through the coordinator — no JSON-store stub.
    const coord = await getSwarmCoordinator();
    for (const id of result.addedAgents!) {
      const live = coord.getAgent(id);
      expect(live, `agent ${id} should be reachable via coordinator`).toBeDefined();
      expect(live!.type).toBe('worker');
    }
  });

  it('scales down via coordinator.terminateAgent (idle agents first)', async () => {
    await callInit();
    await spawnAgentForTest({ agentType: 'worker' });
    await spawnAgentForTest({ agentType: 'worker' });
    await spawnAgentForTest({ agentType: 'worker' });

    const result = await callScale({
      targetAgents: 1,
      scaleStrategy: 'immediate',
      reason: 'integration-test scale-down',
    });

    expect(result.scalingStatus).toBe('completed');
    expect(result.previousAgents).toBe(3);
    expect(result.currentAgents).toBe(1);
    expect(result.removedAgents).toBeDefined();
    expect(result.removedAgents!.length).toBe(2);
    expect(result.addedAgents).toBeUndefined();
    expect(result.reason).toBe('integration-test scale-down');

    const coord = await getSwarmCoordinator();
    const live = coord.getAllAgents().filter(a => a.status !== 'terminated');
    expect(live.length).toBe(1);
  });

  it('respects gradual rate-limiting (≥ 200ms per inter-agent gap)', async () => {
    await callInit();

    const start = Date.now();
    const result = await callScale({
      targetAgents: 3,
      scaleStrategy: 'gradual',
    });
    const elapsed = Date.now() - start;

    expect(result.scalingStatus).toBe('completed');
    expect(result.currentAgents).toBe(3);
    // 3 spawns ⇒ 2 inter-agent gaps × 200 ms = ≥ 400 ms (loosened to 380 to
    // tolerate timer jitter on slow CI; spawn time itself adds further headroom).
    expect(elapsed).toBeGreaterThanOrEqual(380);
  });

  it('is idempotent at target — no spawn/terminate when already there', async () => {
    await callInit();
    await spawnAgentForTest({ agentType: 'worker' });
    await spawnAgentForTest({ agentType: 'worker' });

    const result = await callScale({ targetAgents: 2, scaleStrategy: 'immediate' });

    expect(result.scalingStatus).toBe('completed');
    expect(result.previousAgents).toBe(2);
    expect(result.currentAgents).toBe(2);
    expect(result.addedAgents).toBeUndefined();
    expect(result.removedAgents).toBeUndefined();
  });

  it('round-robins agentTypes when scaling up', async () => {
    await callInit();
    const result = await callScale({
      targetAgents: 4,
      scaleStrategy: 'immediate',
      agentTypes: ['coder', 'tester'],
    });
    expect(result.scalingStatus).toBe('completed');

    const coord = await getSwarmCoordinator();
    const types = result.addedAgents!.map(id => coord.getAgent(id)!.type).sort();
    expect(types).toEqual(['coder', 'coder', 'tester', 'tester']);
  });

  it('rejects targetAgents below 1 without throwing', async () => {
    await callInit();
    const result = await callScale({ targetAgents: 0 });
    expect(result.scalingStatus).toBe('failed');
    expect(result.error).toMatch(/targetAgents/);
  });

  it('rejects targetAgents above the 1000 cap', async () => {
    await callInit();
    const result = await callScale({ targetAgents: 1001 });
    expect(result.scalingStatus).toBe('failed');
    expect(result.error).toMatch(/1000/);
  });

  it('rejects an unknown scaleStrategy', async () => {
    await callInit();
    const result = await callScale({ targetAgents: 1, scaleStrategy: 'turbo' });
    expect(result.scalingStatus).toBe('failed');
    expect(result.error).toMatch(/scaleStrategy/);
  });

  it('rejects unknown agent types via the shared whitelist', async () => {
    await callInit();
    const result = await callScale({
      targetAgents: 2,
      agentTypes: ['definitely-not-a-real-type'],
    });
    expect(result.scalingStatus).toBe('failed');
    expect(result.error).toMatch(/whitelist|allowed|agentTypes/i);
  });

  it('records scaledAt as ISO timestamp and echoes the chosen strategy', async () => {
    await callInit();
    const result = await callScale({ targetAgents: 1, scaleStrategy: 'adaptive' });
    expect(result.scaleStrategy).toBe('adaptive');
    expect(() => new Date(result.scaledAt).toISOString()).not.toThrow();
  });
});
