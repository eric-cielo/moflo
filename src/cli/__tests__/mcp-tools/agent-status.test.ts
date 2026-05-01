/**
 * `agent_status` wired to the live UnifiedSwarmCoordinator (story #802).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { _resetSwarmCoordinatorForTest } from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getAgentTool, spawnAgentForTest } from './_helpers.js';

interface StatusResult {
  agentId: string;
  agentType?: string;
  name?: string;
  status: string;
  health?: number;
  workload?: number;
  domain?: string;
  currentTask?: string;
  lastHeartbeat?: string;
  taskCount?: number;
  metrics?: Record<string, unknown>;
  history?: { tasksCompleted: number; tasksFailed: number; successRate: number };
  error?: string;
}

const statusTool = getAgentTool('agent_status');

async function status(input: Record<string, unknown>): Promise<StatusResult> {
  return (await statusTool.handler(input)) as StatusResult;
}

describe('agent_status — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('returns live AgentState for a coordinator-spawned agent', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'coder' });

    const result = await status({ agentId });
    expect(result.agentId).toBe(agentId);
    expect(result.agentType).toBe('coder');
    expect(result.status).toBe('idle');
    expect(typeof result.health).toBe('number');
    expect(typeof result.workload).toBe('number');
    expect(typeof result.lastHeartbeat).toBe('string');
  });

  it('omits metrics by default and includes them when requested', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'tester' });

    const without = await status({ agentId });
    expect(without.metrics).toBeUndefined();

    const withMetrics = await status({ agentId, includeMetrics: true });
    expect(withMetrics.metrics).toBeDefined();
    expect(withMetrics.metrics).toHaveProperty('tasksCompleted');
    expect(withMetrics.metrics).toHaveProperty('successRate');
    expect(typeof (withMetrics.metrics as { lastActivity: unknown }).lastActivity).toBe('string');
  });

  it('omits history by default and includes it when requested', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'coder' });

    const without = await status({ agentId });
    expect(without.history).toBeUndefined();

    const withHistory = await status({ agentId, includeHistory: true });
    expect(withHistory.history).toBeDefined();
    expect(withHistory.history!.tasksCompleted).toBeGreaterThanOrEqual(0);
    expect(withHistory.history!.tasksFailed).toBeGreaterThanOrEqual(0);
  });

  it('returns status:not_found for unknown agent IDs', async () => {
    const result = await status({ agentId: 'agent-coder-deadbeef00000000deadbeef' });
    expect(result.status).toBe('not_found');
    expect(result.error).toMatch(/not found/i);
  });

  it('returns status:not_found for empty agentId without throwing', async () => {
    const result = await status({ agentId: '' });
    expect(result.status).toBe('not_found');
  });

  it('surfaces the agent domain from the coordinator', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'tester' });
    const result = await status({ agentId });
    // tester maps to "support" in agentTypeToDomain
    expect(result.domain).toBe('support');
  });
});
