/**
 * Story #807 / epic #798 — hive-mind workers ride the shared coordinator.
 *
 * Asserts the three views stay in lockstep:
 *  1. hive-mind_status workers === coordinator.listAgents({ domain: 'hive-mind' })
 *  2. workers visible from BOTH hive-mind_status AND swarm agent_list
 *  3. Bootstrap directive (story #800) is byte-equal on every coordinator record
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hiveMindTools } from '../src/cli/mcp-tools/hive-mind-tools.js';
import { agentTools } from '../src/cli/mcp-tools/agent-tools.js';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../src/cli/mcp-tools/swarm-coordinator-singleton.js';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../src/cli/services/subagent-bootstrap.js';

interface SpawnResult {
  success: boolean;
  spawned?: number;
  workers?: Array<{ agentId: string; role: string; joinedAt: string; bootstrap: string }>;
  totalWorkers?: number;
  error?: string;
}

interface StatusResult {
  workers: Array<{ id: string }>;
  workerCount: number;
}

interface ListResult {
  agents: Array<{ agentId: string; domain?: string }>;
  total: number;
}

const tool = (name: string) => {
  const t = hiveMindTools.find(x => x.name === name) ?? agentTools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};

const init = () => tool('hive-mind_init').handler({ topology: 'mesh' });
const spawn = (count: number, role = 'worker') =>
  tool('hive-mind_spawn').handler({ count, role, agentType: 'worker' }) as Promise<SpawnResult>;
const status = () => tool('hive-mind_status').handler({}) as Promise<StatusResult>;
const list = (domain?: string) =>
  tool('agent_list').handler(domain ? { domain } : {}) as Promise<ListResult>;
const leave = (agentId: string) => tool('hive-mind_leave').handler({ agentId });
const shutdown = () => tool('hive-mind_shutdown').handler({ graceful: true, force: true });

describe('hive-mind ↔ coordinator continuity (story #807)', () => {
  beforeEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  afterEach(async () => {
    // Shutdown clears hive state singleton AND terminates coordinator agents,
    // then reset the coordinator so the next test boots a fresh one. Tests
    // that already shut down (or error before init) make this a no-op; we
    // surface the message so a real teardown bug isn't lost in the noise.
    try { await shutdown(); } catch (err) {
      process.stderr.write(`[test teardown] shutdown failed: ${(err as Error).message}\n`);
    }
    await _resetSwarmCoordinatorForTest();
  });

  it('hive-mind_spawn registers each worker with the coordinator', async () => {
    await init();
    const result = await spawn(3);

    expect(result.success).toBe(true);
    expect(result.spawned).toBe(3);

    const coord = await getSwarmCoordinator();
    const live = coord.listAgents({ domain: 'hive-mind' });
    expect(live.length).toBe(3);

    // Every worker returned by spawn must be reachable via getAgent
    for (const w of result.workers!) {
      const agent = coord.getAgent(w.agentId);
      expect(agent, `coordinator missing agent ${w.agentId}`).toBeDefined();
      expect(agent!.type).toBe('worker');
    }
  });

  it('hive-mind_status workerCount matches coordinator domain count', async () => {
    await init();
    await spawn(4);

    const s = await status();
    const coord = await getSwarmCoordinator();
    const domainAgents = coord.listAgents({ domain: 'hive-mind' });

    expect(s.workerCount).toBe(domainAgents.length);
    expect(s.workers.length).toBe(domainAgents.length);
  });

  it('workers are visible from BOTH hive-mind_status AND swarm agent_list', async () => {
    await init();
    const result = await spawn(2);

    const s = await status();
    const swarmList = await list('hive-mind');

    const hiveIds = new Set(s.workers.map(w => w.id));
    const swarmIds = new Set(swarmList.agents.map(a => a.agentId));

    for (const w of result.workers!) {
      expect(hiveIds.has(w.agentId), `${w.agentId} missing from hive view`).toBe(true);
      expect(swarmIds.has(w.agentId), `${w.agentId} missing from swarm view`).toBe(true);
    }
  });

  it('embeds the canonical bootstrap directive byte-for-byte on every worker record', async () => {
    await init();
    const result = await spawn(3);

    expect(result.success).toBe(true);
    expect(result.workers!.length).toBe(3);

    // Story-acceptance check: byte-equal directive on every spawn record.
    for (const w of result.workers!) {
      expect(w.bootstrap).toBe(SUBAGENT_BOOTSTRAP_DIRECTIVE);
    }
  });

  it('hive-mind_leave terminates the coordinator-side record', async () => {
    await init();
    const result = await spawn(2);
    const [w1] = result.workers!;

    await leave(w1.agentId);

    const coord = await getSwarmCoordinator();
    expect(coord.getAgent(w1.agentId)).toBeUndefined();

    // Survivor still present
    const remaining = coord.listAgents({ domain: 'hive-mind' });
    expect(remaining.length).toBe(1);
  });

  it('hive-mind_shutdown terminates every coordinator worker in the domain', async () => {
    await init();
    await spawn(3);

    const coord = await getSwarmCoordinator();
    expect(coord.listAgents({ domain: 'hive-mind' }).length).toBe(3);

    await shutdown();

    expect(coord.listAgents({ domain: 'hive-mind' }).length).toBe(0);
  });

  it('rejects unknown agent types without spawning a coordinator record', async () => {
    await init();
    const r = await tool('hive-mind_spawn').handler({
      count: 1,
      agentType: 'definitely-not-a-real-type',
    }) as SpawnResult;

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/whitelist|allowed/i);

    const coord = await getSwarmCoordinator();
    expect(coord.listAgents({ domain: 'hive-mind' }).length).toBe(0);
  });
});
