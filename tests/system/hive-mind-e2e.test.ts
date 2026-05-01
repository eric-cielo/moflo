/**
 * System E2E: hive-mind end-to-end.
 *
 * Drives every hive-mind MCP surface (init / spawn / broadcast / consensus /
 * shutdown) and verifies hive workers spawned via `hive-mind_spawn` are
 * visible to swarm `agent_list` because they register with the same
 * UnifiedSwarmCoordinator.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getSwarmCoordinator } from '../../src/cli/mcp-tools/swarm-coordinator-singleton.js';
import {
  getAgentTool,
  getHiveMindTool,
  resetHiveAndSwarm,
} from '../../src/cli/__tests__/mcp-tools/_helpers.js';
import { checkHiveMindFunctional } from '../../src/cli/commands/doctor-checks-swarm.js';

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

interface ConsensusListResult {
  recentHistory: Array<{
    proposalId: string;
    result: string;
    votes: { for: number; against: number };
  }>;
}

interface ShutdownResult {
  success: boolean;
  workersTerminated: number;
}

interface AgentListResult {
  agents: Array<{ agentId: string; agentType: string; domain?: string }>;
  total: number;
}

describe('System E2E — hive-mind', () => {
  afterEach(resetHiveAndSwarm);

  it('init → spawn × 3 → workers visible via swarm agent_list', async () => {
    const init = (await getHiveMindTool('hive-mind_init').handler({ topology: 'mesh' })) as InitResult;
    expect(init.success).toBe(true);
    expect(init.status).toBe('initialized');
    expect(init.hiveId).toBeTruthy();

    const spawn = (await getHiveMindTool('hive-mind_spawn').handler({
      count: 3,
      role: 'worker',
      agentType: 'worker',
    })) as SpawnResult;

    expect(spawn.success).toBe(true);
    expect(spawn.spawned).toBe(3);
    expect(spawn.workers).toHaveLength(3);
    expect(spawn.totalWorkers).toBe(3);

    // Each spawned worker registers with the shared coordinator under the
    // `hive-mind` domain — not just the legacy file-store.
    const coord = await getSwarmCoordinator();
    for (const worker of spawn.workers) {
      const live = coord.getAgent(worker.agentId);
      expect(live, `worker ${worker.agentId} should exist on coordinator`).toBeDefined();
      expect(coord.getDomainForAgent(worker.agentId)).toBe('hive-mind');
    }

    const list = (await getAgentTool('agent_list').handler({ domain: 'hive-mind' })) as AgentListResult;
    expect(list.total).toBe(3);
    const listIds = list.agents.map(a => a.agentId).sort();
    const spawnIds = spawn.workers.map(w => w.agentId).sort();
    expect(listIds).toEqual(spawnIds);
  });

  it('broadcast reaches every spawned worker (recipients = worker count)', async () => {
    await getHiveMindTool('hive-mind_init').handler({ topology: 'mesh' });
    const spawn = (await getHiveMindTool('hive-mind_spawn').handler({
      count: 3,
      agentType: 'worker',
    })) as SpawnResult;

    const broadcast = (await getHiveMindTool('hive-mind_broadcast').handler({
      message: 'test-broadcast',
      priority: 'high',
    })) as BroadcastResult;

    expect(broadcast.success).toBe(true);
    expect(broadcast.messageId).toBeTruthy();
    expect(broadcast.recipients).toBe(spawn.workers.length);
  });

  it('consensus tallies real votes (not a stubbed approval)', async () => {
    await getHiveMindTool('hive-mind_init').handler({ topology: 'mesh' });
    const spawn = (await getHiveMindTool('hive-mind_spawn').handler({
      count: 3,
      agentType: 'worker',
    })) as SpawnResult;
    const workerIds = spawn.workers.map(w => w.agentId);

    const proposal = (await getHiveMindTool('hive-mind_consensus').handler({
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
    const v1 = (await getHiveMindTool('hive-mind_consensus').handler({
      action: 'vote',
      proposalId: proposal.proposalId,
      vote: true,
      voterId: workerIds[0],
    })) as ConsensusVoteResult;
    expect(v1.votesFor).toBe(1);
    expect(v1.votesAgainst).toBe(0);
    expect(v1.status).toBe('pending');

    // Second "for" vote crosses majority — proposal flips to approved.
    const v2 = (await getHiveMindTool('hive-mind_consensus').handler({
      action: 'vote',
      proposalId: proposal.proposalId,
      vote: true,
      voterId: workerIds[1],
    })) as ConsensusVoteResult;
    expect(v2.votesFor).toBe(2);
    expect(v2.status).toBe('approved');

    // History contains the resolved decision (not a stubbed `result: 'approved'`).
    const list = (await getHiveMindTool('hive-mind_consensus').handler({
      action: 'list',
    })) as ConsensusListResult;
    const decided = list.recentHistory.find(h => h.proposalId === proposal.proposalId);
    expect(decided).toBeDefined();
    expect(decided!.result).toBe('approved');
    expect(decided!.votes.for).toBe(2);
    expect(decided!.votes.against).toBe(0);
  });

  // Issue #818: gate the regression that triggered epic #798. The doctor
  // check exercises hive-mind_init / spawn / broadcast / consensus / memory
  // through MessageBus + WriteThroughAdapter + shared coordinator — if any
  // handler stubs out, this fails before the bad install ships.
  it('checkHiveMindFunctional passes against the live MessageBus + coordinator', { timeout: 30_000 }, async () => {
    const result = await checkHiveMindFunctional();
    if (result.status === 'warn' && /not built/i.test(result.message)) return;

    const failures = (result.details ?? []).filter(d => d.status === 'fail');
    expect(failures, `hive-mind doctor failures (epic #798 regression?): ${JSON.stringify(failures, null, 2)}`).toHaveLength(0);
    expect(result.status).not.toBe('fail');
  });

  it('hive-mind_shutdown terminates coordinator-side records (workers leave swarm agent_list)', async () => {
    await getHiveMindTool('hive-mind_init').handler({ topology: 'mesh' });
    const spawn = (await getHiveMindTool('hive-mind_spawn').handler({
      count: 2,
      agentType: 'worker',
    })) as SpawnResult;

    const beforeList = (await getAgentTool('agent_list').handler({
      domain: 'hive-mind',
    })) as AgentListResult;
    expect(beforeList.total).toBe(2);

    const shutdown = (await getHiveMindTool('hive-mind_shutdown').handler({
      force: true,
    })) as ShutdownResult;
    expect(shutdown.success).toBe(true);
    expect(shutdown.workersTerminated).toBe(2);

    // `terminateAgent` calls `unregisterAgent` (state.agents.delete) — workers
    // are removed entirely, not held with status='terminated'.
    const afterList = (await getAgentTool('agent_list').handler({
      domain: 'hive-mind',
    })) as AgentListResult;
    expect(afterList.total).toBe(0);

    const coord = await getSwarmCoordinator();
    for (const worker of spawn.workers) {
      expect(coord.getAgent(worker.agentId)).toBeUndefined();
    }
  });
});
