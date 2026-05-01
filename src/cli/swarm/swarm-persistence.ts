/**
 * Swarm Persistence Layer (Story #806 — Epic #798)
 *
 * Continues the Story #121 hive-mind pattern: writes coordinator state through
 * to moflo.db so the swarm survives MCP-server restart. Decoupled from the
 * coordinator via dependency injection so tests can substitute an in-memory
 * fake without touching sql.js.
 */

import type {
  AgentCapabilities,
  AgentMetrics,
  AgentState,
  AgentStatus,
  AgentType,
  ConsensusResult,
  TopologyState,
} from './types.js';
import type { AgentDomain } from './unified-coordinator.js';

export const SWARM_AGENTS_NS = 'swarm-agents' as const;
export const SWARM_TOPOLOGY_NS = 'swarm-topology' as const;
export const SWARM_CONSENSUS_NS = 'swarm-consensus' as const;

const AGENT_KEY_PREFIX = 'agent:';
const PROPOSAL_KEY_PREFIX = 'proposal:';
const TOPOLOGY_KEY = 'current';

/** Memory-DB primitives the coordinator needs. Mirrors memory-initializer.ts. */
export interface SwarmMemoryFns {
  storeEntry: (opts: {
    key: string;
    value: string;
    namespace: string;
    tags?: string[];
    upsert?: boolean;
    generateEmbeddingFlag?: boolean;
  }) => Promise<{ success: boolean; id: string; error?: string }>;
  getEntry: (opts: {
    key: string;
    namespace?: string;
  }) => Promise<{ success: boolean; found: boolean; entry?: { content: string } }>;
  listEntries: (opts: {
    namespace?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{ success: boolean; entries: Array<{ key: string }>; total: number }>;
  deleteEntry: (opts: {
    key: string;
    namespace?: string;
  }) => Promise<{ success: boolean; deleted: boolean }>;
}

export interface PersistedAgent {
  id: string;
  type: AgentType;
  name: string;
  status: AgentStatus;
  capabilities: AgentCapabilities;
  metrics: Omit<AgentMetrics, 'lastActivity'> & { lastActivity: string };
  workload: number;
  health: number;
  domain?: AgentDomain;
}

export interface PersistedTopology {
  type: TopologyState['type'];
  nodeCount: number;
  edgeCount: number;
  partitionCount: number;
  leader?: string;
}

export interface PersistedConsensus {
  proposalId: string;
  approved: boolean;
  approvalRate: number;
  decidedAt: string;
}

/**
 * Thin write/read facade over `SwarmMemoryFns`. Writes are fire-and-forget so
 * a failed/missing memory backend never blocks the in-memory coordinator —
 * persistence is best-effort durability, not a hot-path dependency.
 */
export class SwarmPersistence {
  private fns: SwarmMemoryFns;
  private lastTopologyJson?: string;

  constructor(fns: SwarmMemoryFns) {
    this.fns = fns;
  }

  async persistAgent(agent: AgentState, domain?: AgentDomain): Promise<void> {
    const record: PersistedAgent = {
      id: agent.id.id,
      type: agent.type,
      name: agent.name,
      status: agent.status,
      capabilities: agent.capabilities,
      metrics: {
        ...agent.metrics,
        lastActivity: agent.metrics.lastActivity.toISOString(),
      },
      workload: agent.workload,
      health: agent.health,
      domain,
    };
    await this.safeStore(`${AGENT_KEY_PREFIX}${agent.id.id}`, SWARM_AGENTS_NS, record, [
      'swarm', 'agent', agent.type,
    ]);
  }

  async removeAgent(agentId: string): Promise<void> {
    try {
      await this.fns.deleteEntry({
        key: `${AGENT_KEY_PREFIX}${agentId}`,
        namespace: SWARM_AGENTS_NS,
      });
    } catch { /* best-effort */ }
  }

  async persistTopology(topology: TopologyState): Promise<void> {
    const snapshot: PersistedTopology = {
      type: topology.type,
      nodeCount: topology.nodes.length,
      edgeCount: topology.edges.length,
      partitionCount: topology.partitions.length,
      leader: topology.leader,
    };

    // Skip the upsert when nothing changed since the last write — most spawn
    // bursts emit node.added + topology.rebalanced back-to-back which would
    // otherwise produce two identical rows.
    const json = JSON.stringify(snapshot);
    if (json === this.lastTopologyJson) return;
    this.lastTopologyJson = json;

    await this.safeStore(TOPOLOGY_KEY, SWARM_TOPOLOGY_NS, snapshot, ['swarm', 'topology']);
  }

  async persistConsensus(result: ConsensusResult): Promise<void> {
    const record: PersistedConsensus = {
      proposalId: result.proposalId,
      approved: result.approved,
      approvalRate: result.approvalRate,
      decidedAt: new Date().toISOString(),
    };
    await this.safeStore(
      `${PROPOSAL_KEY_PREFIX}${result.proposalId}`,
      SWARM_CONSENSUS_NS,
      record,
      ['swarm', 'consensus', result.approved ? 'approved' : 'rejected'],
    );
  }

  async loadAgents(): Promise<PersistedAgent[]> {
    return this.loadList<PersistedAgent>(
      SWARM_AGENTS_NS,
      AGENT_KEY_PREFIX,
      (r): boolean => {
        const rec = r as Partial<PersistedAgent>;
        return typeof rec.id === 'string' && typeof rec.type === 'string';
      },
    );
  }

  async loadTopology(): Promise<PersistedTopology | undefined> {
    try {
      const got = await this.fns.getEntry({ key: TOPOLOGY_KEY, namespace: SWARM_TOPOLOGY_NS });
      if (!got.success || !got.found || !got.entry?.content) return undefined;
      return JSON.parse(got.entry.content) as PersistedTopology;
    } catch {
      return undefined;
    }
  }

  async loadConsensusHistory(limit = 50): Promise<PersistedConsensus[]> {
    return this.loadList<PersistedConsensus>(SWARM_CONSENSUS_NS, PROPOSAL_KEY_PREFIX, undefined, limit);
  }

  private async safeStore(
    key: string,
    namespace: string,
    record: unknown,
    tags: string[],
  ): Promise<void> {
    try {
      await this.fns.storeEntry({
        key,
        value: JSON.stringify(record),
        namespace,
        tags,
        upsert: true,
        // High-churn lifecycle records — skip embedding to avoid hot-path
        // model loads. They're keyed lookups, not semantic search targets.
        generateEmbeddingFlag: false,
      });
    } catch {
      // Best-effort: never let persistence failures crash the in-memory swarm.
    }
  }

  private async loadList<T>(
    namespace: string,
    keyPrefix: string,
    isValid?: (record: unknown) => boolean,
    limit = 1000,
  ): Promise<T[]> {
    try {
      const list = await this.fns.listEntries({ namespace, limit });
      if (!list.success) return [];

      const records: T[] = [];
      for (const entry of list.entries) {
        if (!entry.key.startsWith(keyPrefix)) continue;
        const got = await this.fns.getEntry({ key: entry.key, namespace });
        if (!got.success || !got.found || !got.entry?.content) continue;
        try {
          const parsed = JSON.parse(got.entry.content);
          if (!isValid || isValid(parsed)) {
            records.push(parsed as T);
          }
        } catch { /* drop malformed records */ }
      }
      return records;
    } catch {
      return [];
    }
  }
}
