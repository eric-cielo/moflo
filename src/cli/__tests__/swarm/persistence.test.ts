/**
 * Story #806 — Swarm restart persistence.
 *
 * Verifies that agents/topology survive `_resetSwarmCoordinatorForTest()`
 * (the test analogue of an MCP-server restart) when an in-memory persistence
 * backend is wired into the singleton.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  _setSwarmPersistenceForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { agentTools } from '../../mcp-tools/agent-tools.js';
import {
  SWARM_AGENTS_NS,
  SWARM_TOPOLOGY_NS,
  SwarmPersistence,
  type SwarmMemoryFns,
} from '../../swarm/swarm-persistence.js';

interface FakeRow {
  key: string;
  namespace: string;
  content: string;
}

/**
 * sql.js-free fake persistence backend. Captures every storeEntry/deleteEntry
 * call across coordinator boots so tests can assert the same writes that
 * would have hit moflo.db in production.
 */
function createInMemoryFns(): { fns: SwarmMemoryFns; rows: Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>();
  const compositeKey = (namespace: string, key: string) => `${namespace}::${key}`;

  const fns: SwarmMemoryFns = {
    async storeEntry(opts) {
      rows.set(compositeKey(opts.namespace, opts.key), {
        key: opts.key,
        namespace: opts.namespace,
        content: opts.value,
      });
      return { success: true, id: `id_${rows.size}` };
    },
    async getEntry(opts) {
      const ns = opts.namespace ?? 'default';
      const row = rows.get(compositeKey(ns, opts.key));
      if (!row) return { success: true, found: false };
      return { success: true, found: true, entry: { content: row.content } };
    },
    async listEntries(opts) {
      const ns = opts.namespace;
      const entries = ns
        ? Array.from(rows.values()).filter(r => r.namespace === ns)
        : Array.from(rows.values());
      return {
        success: true,
        entries: entries.map(r => ({ key: r.key })),
        total: entries.length,
      };
    },
    async deleteEntry(opts) {
      const ns = opts.namespace ?? 'default';
      const existed = rows.delete(compositeKey(ns, opts.key));
      return { success: true, deleted: existed };
    },
  };

  return { fns, rows };
}

function getAgentTool(name: string) {
  const tool = agentTools.find(t => t.name === name);
  if (!tool) throw new Error(`agent tool "${name}" not registered`);
  return tool;
}

describe('Swarm restart persistence (story #806)', () => {
  let backend: ReturnType<typeof createInMemoryFns>;

  beforeEach(() => {
    backend = createInMemoryFns();
    _setSwarmPersistenceForTest(new SwarmPersistence(backend.fns));
  });

  afterEach(async () => {
    _setSwarmPersistenceForTest(null);
    await _resetSwarmCoordinatorForTest();
  });

  it('writes spawned agents into the swarm-agents namespace', async () => {
    const spawn = getAgentTool('agent_spawn');
    const result = (await spawn.handler({ agentType: 'coder' })) as { success: boolean; agentId: string };
    expect(result.success).toBe(true);

    const agentRows = Array.from(backend.rows.values()).filter(r => r.namespace === SWARM_AGENTS_NS);
    expect(agentRows.length).toBe(1);
    expect(agentRows[0].key).toBe(`agent:${result.agentId}`);

    const parsed = JSON.parse(agentRows[0].content);
    expect(parsed.id).toBe(result.agentId);
    expect(parsed.type).toBe('coder');
    expect(parsed.domain).toBe('core');
  });

  it('restarts spawn → reset → re-init and recovers both agents', async () => {
    const spawn = getAgentTool('agent_spawn');
    const list = getAgentTool('agent_list');

    const a1 = (await spawn.handler({ agentType: 'coder' })) as { agentId: string };
    const a2 = (await spawn.handler({ agentType: 'researcher' })) as { agentId: string };
    expect(a1.agentId).toBeTruthy();
    expect(a2.agentId).toBeTruthy();

    // Sanity: both rows are persisted before we kill the coordinator.
    const before = Array.from(backend.rows.values()).filter(r => r.namespace === SWARM_AGENTS_NS);
    expect(before.length).toBe(2);

    // Simulate MCP-server restart — drop the in-memory coordinator and re-boot.
    await _resetSwarmCoordinatorForTest();

    const listed = (await list.handler({})) as {
      agents: Array<{ agentId: string; agentType: string }>;
      total: number;
    };

    expect(listed.total).toBe(2);
    const ids = listed.agents.map(a => a.agentId).sort();
    expect(ids).toEqual([a1.agentId, a2.agentId].sort());
    const types = listed.agents.map(a => a.agentType).sort();
    expect(types).toEqual(['coder', 'researcher']);
  });

  it('removes terminated agents from the persisted set', async () => {
    const spawn = getAgentTool('agent_spawn');
    const terminate = getAgentTool('agent_terminate');

    const a1 = (await spawn.handler({ agentType: 'tester' })) as { agentId: string };
    const a2 = (await spawn.handler({ agentType: 'reviewer' })) as { agentId: string };

    const term = (await terminate.handler({ agentId: a1.agentId, force: true })) as {
      success: boolean;
    };
    expect(term.success).toBe(true);

    const remaining = Array.from(backend.rows.values()).filter(r => r.namespace === SWARM_AGENTS_NS);
    expect(remaining.length).toBe(1);
    expect(remaining[0].key).toBe(`agent:${a2.agentId}`);

    await _resetSwarmCoordinatorForTest();

    const list = getAgentTool('agent_list');
    const listed = (await list.handler({})) as { agents: Array<{ agentId: string }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.agents[0].agentId).toBe(a2.agentId);
  });

  it('persists a topology snapshot under swarm-topology', async () => {
    const spawn = getAgentTool('agent_spawn');
    await spawn.handler({ agentType: 'coder' });
    await spawn.handler({ agentType: 'reviewer' });

    // Topology writes are microtask-debounced + fire-and-forget; yield until
    // a row appears (capped) so the test isn't racing the write.
    for (let attempt = 0; attempt < 20; attempt++) {
      const hasRow = Array.from(backend.rows.values()).some(
        r => r.namespace === SWARM_TOPOLOGY_NS,
      );
      if (hasRow) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const topologyRows = Array.from(backend.rows.values()).filter(
      r => r.namespace === SWARM_TOPOLOGY_NS,
    );
    expect(topologyRows.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(topologyRows[0].content);
    expect(snapshot.type).toBeDefined();
    expect(snapshot.nodeCount).toBeGreaterThanOrEqual(2);
  });

  it('runs cleanly when no persistence backend is wired', async () => {
    // Override path: explicitly clear and re-boot. With the test-only override
    // null'd and no real memory backend in this isolated process, the
    // coordinator must still spawn agents in-memory.
    _setSwarmPersistenceForTest(null);
    await _resetSwarmCoordinatorForTest();

    // Directly drive the coordinator (bypass MCP path so the singleton can't
    // re-attach the test fake from a previous turn).
    const coord = await getSwarmCoordinator();
    const spawned = await coord.spawnAgent({ type: 'worker' });
    expect(spawned.spawned).toBe(true);
    expect(coord.getAgent(spawned.agentId)).toBeDefined();
  });
});
