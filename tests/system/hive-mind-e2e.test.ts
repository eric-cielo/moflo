/**
 * System E2E: hive-mind end-to-end (epic #798, story #808).
 *
 * Drives every hive-mind MCP surface (init / spawn / broadcast / consensus /
 * shutdown) and cross-validates Story #807: hive workers spawned via
 * `hive-mind_spawn` MUST be visible to swarm `agent_list` because they are
 * registered with the same UnifiedSwarmCoordinator.
 *
 * Coverage:
 *   1. init → spawn × 3 → workers reachable from swarm agent_list (#807)
 *   2. broadcast publishes through MessageBus (recipients = worker count)
 *   3. consensus propose/vote tally crosses majority and flips status to
 *      `approved` — verifying real vote counting, not a stubbed result
 *   4. hive-mind_shutdown terminates the coordinator-side worker records
 *      so swarm agent_list no longer sees them
 */

import { afterEach, describe, expect, it } from 'vitest';
import { agentTools } from '../../src/cli/mcp-tools/agent-tools.js';
import { hiveMindTools } from '../../src/cli/mcp-tools/hive-mind-tools.js';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../src/cli/mcp-tools/swarm-coordinator-singleton.js';

// ===== helpers =====

function tool<T extends { name: string; handler: (input: Record<string, unknown>) => Promise<unknown> }>(
  set: readonly T[],
  name: string,
): T {
  const found = set.find(t => t.name === name);
  if (!found) throw new Error(`tool "${name}" not registered`);
  return found;
}

interface InitResult {
  success: boolean;
  hiveId: string;
  topology: string;
  status: string;
}

interface SpawnResult {
  success: boolean;
  spawned: number;
  workers: Array<{ agentId: string; role: string; bootstrap: string }>;
  totalWorkers: number;
}

interface BroadcastResult {
  success: boolean;
  messageId: string;
  recipients: number;
}

interface ConsensusProposeResult {
  proposalId: string;
  status: string;
  requiredVotes: number;
}

interface ConsensusVoteResult {
  proposalId: string;
  status: string;
  votesFor: number;
  votesAgainst: number;
}

interface ShutdownResult {
  success: boolean;
  workersTerminated: number;
}

interface AgentListResult {
  agents: Array<{ agentId: string; agentType: string; domain?: string }>;
  total: number;
}

// ===== tests =====

describe('System E2E — hive-mind (epic #798, story #807 cross-check)', () => {
  afterEach(async () => {
    // Best-effort hive shutdown — second one short-circuits when state is
    // already cleared, which is what we want when a test left a live hive.
    try {
      await tool(hiveMindTools, 'hive-mind_shutdown').handler({ force: true });
    } catch {
      // ignored — hive already torn down
    }
    await _resetSwarmCoordinatorForTest();
  });

  it('init → spawn × 3 → workers visible via swarm agent_list (#807)', async () => {
    const init = (await tool(hiveMindTools, 'hive-mind_init').handler({ topology: 'mesh' })) as InitResult;
    expect(init.success).toBe(true);
    expect(init.status).toBe('initialized');
    expect(init.hiveId).toBeTruthy();

    const spawn = (await tool(hiveMindTools, 'hive-mind_spawn').handler({
      count: 3,
      role: 'worker',
      agentType: 'worker',
    })) as SpawnResult;

    expect(spawn.success).toBe(true);
    expect(spawn.spawned).toBe(3);
    expect(spawn.workers).toHaveLength(3);
    expect(spawn.totalWorkers).toBe(3);

    // Story #807: each spawned worker must be registered with the shared
    // coordinator under the `hive-mind` domain — not just in the legacy
    // file-store.
    const coord = await getSwarmCoordinator();
    for (const worker of spawn.workers) {
      const live = coord.getAgent(worker.agentId);
      expect(live, `worker ${worker.agentId} should exist on coordinator`).toBeDefined();
      expect(coord.getDomainForAgent(worker.agentId)).toBe('hive-mind');
    }

    const list = (await tool(agentTools, 'agent_list').handler({ domain: 'hive-mind' })) as AgentListResult;
    expect(list.total).toBe(3);
    const listIds = list.agents.map(a => a.agentId).sort();
    const spawnIds = spawn.workers.map(w => w.agentId).sort();
    expect(listIds).toEqual(spawnIds);
  });

  it('broadcast reaches every spawned worker (recipients = worker count)', async () => {
    await tool(hiveMindTools, 'hive-mind_init').handler({ topology: 'mesh' });
    const spawn = (await tool(hiveMindTools, 'hive-mind_spawn').handler({
      count: 3,
      agentType: 'worker',
    })) as SpawnResult;

    const broadcast = (await tool(hiveMindTools, 'hive-mind_broadcast').handler({
      message: 'test-broadcast',
      priority: 'high',
    })) as BroadcastResult;

    expect(broadcast.success).toBe(true);
    expect(broadcast.messageId).toBeTruthy();
    expect(broadcast.recipients).toBe(spawn.workers.length);
  });

  it('consensus tallies real votes (not a stubbed approval)', async () => {
    await tool(hiveMindTools, 'hive-mind_init').handler({ topology: 'mesh' });
    const spawn = (await tool(hiveMindTools, 'hive-mind_spawn').handler({
      count: 3,
      agentType: 'worker',
    })) as SpawnResult;
    const workerIds = spawn.workers.map(w => w.agentId);

    const proposal = (await tool(hiveMindTools, 'hive-mind_consensus').handler({
      action: 'propose',
      type: 'test-decision',
      value: { proposed: true },
      voterId: workerIds[0],
    })) as ConsensusProposeResult;
    expect(proposal.proposalId).toBeTruthy();
    expect(proposal.status).toBe('pending');
    // 3 workers → majority is floor(3/2) + 1 = 2.
    expect(proposal.requiredVotes).toBe(2);

    // First "for" vote — still pending, tally is 1/0.
    const v1 = (await tool(hiveMindTools, 'hive-mind_consensus').handler({
      action: 'vote',
      proposalId: proposal.proposalId,
      vote: true,
      voterId: workerIds[0],
    })) as ConsensusVoteResult;
    expect(v1.votesFor).toBe(1);
    expect(v1.votesAgainst).toBe(0);
    expect(v1.status).toBe('pending');

    // Second "for" vote crosses majority — proposal flips to approved.
    const v2 = (await tool(hiveMindTools, 'hive-mind_consensus').handler({
      action: 'vote',
      proposalId: proposal.proposalId,
      vote: true,
      voterId: workerIds[1],
    })) as ConsensusVoteResult;
    expect(v2.votesFor).toBe(2);
    expect(v2.status).toBe('approved');

    // History must contain the resolved decision (not a stubbed `result: 'approved'`).
    const list = (await tool(hiveMindTools, 'hive-mind_consensus').handler({
      action: 'list',
    })) as { recentHistory: Array<{ proposalId: string; result: string; votes: { for: number; against: number } }> };
    const decided = list.recentHistory.find(h => h.proposalId === proposal.proposalId);
    expect(decided).toBeDefined();
    expect(decided!.result).toBe('approved');
    expect(decided!.votes.for).toBe(2);
    expect(decided!.votes.against).toBe(0);
  });

  it('hive-mind_shutdown terminates coordinator-side records (workers leave swarm agent_list)', async () => {
    await tool(hiveMindTools, 'hive-mind_init').handler({ topology: 'mesh' });
    const spawn = (await tool(hiveMindTools, 'hive-mind_spawn').handler({
      count: 2,
      agentType: 'worker',
    })) as SpawnResult;

    const beforeList = (await tool(agentTools, 'agent_list').handler({
      domain: 'hive-mind',
    })) as AgentListResult;
    expect(beforeList.total).toBe(2);

    const shutdown = (await tool(hiveMindTools, 'hive-mind_shutdown').handler({
      force: true,
    })) as ShutdownResult;
    expect(shutdown.success).toBe(true);
    expect(shutdown.workersTerminated).toBe(2);

    // Story #807: workers must be torn down on the coordinator too —
    // `agent_list` filtered to the hive-mind domain returns nothing because
    // `terminateAgent` removes them via `unregisterAgent` (state.agents.delete).
    const afterList = (await tool(agentTools, 'agent_list').handler({
      domain: 'hive-mind',
    })) as AgentListResult;
    expect(afterList.total).toBe(0);

    // Belt-and-suspenders: getAgent returns undefined now — workers fully gone.
    const coord = await getSwarmCoordinator();
    for (const worker of spawn.workers) {
      expect(coord.getAgent(worker.agentId)).toBeUndefined();
    }
  });
});
