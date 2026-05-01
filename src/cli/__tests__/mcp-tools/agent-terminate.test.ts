/**
 * `agent_terminate` wired to the live UnifiedSwarmCoordinator (story #802).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getAgentTool, spawnAgentForTest } from './_helpers.js';

interface TerminateResult {
  success: boolean;
  agentId: string;
  terminated?: boolean;
  tasksReassigned?: number;
  reason?: string;
  terminatedAt?: string;
  error?: string;
}

const terminateTool = getAgentTool('agent_terminate');

async function terminate(input: Record<string, unknown>): Promise<TerminateResult> {
  return (await terminateTool.handler(input)) as TerminateResult;
}

describe('agent_terminate — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('removes the agent from coordinator state', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'coder' });

    const result = await terminate({ agentId });
    expect(result.success).toBe(true);
    expect(result.terminated).toBe(true);
    expect(result.agentId).toBe(agentId);
    expect(typeof result.terminatedAt).toBe('string');

    const coord = await getSwarmCoordinator();
    expect(coord.getAgent(agentId)).toBeUndefined();
  });

  it('is idempotent — second call returns success:false with not found', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'tester' });
    await terminate({ agentId });

    const second = await terminate({ agentId });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/not found/i);
  });

  it('returns success:false for unknown agent IDs (no throw)', async () => {
    const result = await terminate({ agentId: 'agent-coder-deadbeef00000000deadbeef' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('rejects empty agentId without throwing', async () => {
    const result = await terminate({ agentId: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('passes the reason through to the coordinator response', async () => {
    const agentId = await spawnAgentForTest({ agentType: 'coder' });
    const result = await terminate({ agentId, reason: 'unit-test cleanup' });
    expect(result.success).toBe(true);
    expect(result.reason).toBe('unit-test cleanup');
  });
});
