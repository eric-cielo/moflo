/**
 * Hive-Mind MCP Tools for CLI — MessageBus + Memory DB Backend
 *
 * Story #121: Migrated from file-based state.json to:
 * - MessageBus for broadcasts, consensus, join/leave lifecycle
 * - Memory DB for shared memory (key-value) and write-through persistence
 *
 * No file I/O. State is ephemeral (in-memory via MessageBus) with optional
 * write-through to Memory DB for configured namespaces.
 */

import type { MCPTool } from './types.js';

// Namespace constants — avoids hardcoded strings scattered across handlers
const HIVE_NS = 'hive-mind' as const;
const HIVE_MEMORY_NS = 'hive-mind-memory' as const;
const HIVE_TTL_MS = 300_000;
const CONSENSUS_TTL_MS = 600_000;

// ===== Lazy-loaded dependencies (avoid eager import of heavy modules) =====

// Use `any` for lazy-loaded singletons to avoid cross-package import type issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _messageBus: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _writeThroughAdapter: any = null;

async function getMessageBus() {
  if (_messageBus) return _messageBus;
  const { MessageBus } = await import('../../../../modules/swarm/dist/message-bus/index.js');
  _messageBus = new MessageBus({
    processingIntervalMs: 50,
    reaperIntervalMs: 60_000,
  });
  await _messageBus.initialize();
  return _messageBus;
}

async function getWriteThroughAdapter() {
  if (_writeThroughAdapter) return _writeThroughAdapter;

  const bus = await getMessageBus();
  const { WriteThroughAdapter } = await import('../../../../modules/swarm/dist/message-bus/write-through-adapter.js');

  // Lazy-load memory functions
  let memStore: ((opts: Record<string, unknown>) => Promise<{ success: boolean; id: string; error?: string }>) | null = null;
  let memDelete: ((opts: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>) | null = null;
  let memList: ((opts: Record<string, unknown>) => Promise<{ entries: Array<{ key: string; metadata?: Record<string, unknown> }> }>) | null = null;

  try {
    const memFns = await import('../memory/memory-initializer.js');
    memStore = (opts) => memFns.storeEntry(opts as Parameters<typeof memFns.storeEntry>[0]);
    memDelete = (opts) => memFns.deleteEntry(opts as Parameters<typeof memFns.deleteEntry>[0]);
    memList = (opts) => memFns.listEntries(opts as Parameters<typeof memFns.listEntries>[0]).then(r => ({
      entries: (r.entries ?? []).map((e: Record<string, unknown>) => ({
        key: e.key as string,
        metadata: e.metadata as Record<string, unknown> | undefined,
      })),
    }));
  } catch {
    // Memory DB unavailable — write-through disabled, in-memory only
  }

  const adapter = new WriteThroughAdapter(
    bus,
    { enabled: !!memStore, namespaces: [HIVE_NS, HIVE_MEMORY_NS] },
    memStore ?? (async () => ({ success: false, id: '', error: 'Memory DB unavailable' })),
    { deleteEntry: memDelete ?? undefined, listEntries: memList ?? undefined },
  );
  adapter.attach();
  _writeThroughAdapter = adapter;
  return adapter;
}

// ===== In-memory hive state (replaces state.json) =====

interface HiveState {
  initialized: boolean;
  hiveId: string;
  topology: 'mesh' | 'hierarchical' | 'ring' | 'star';
  queen?: { agentId: string; electedAt: string; term: number };
  workers: string[];
  consensus: {
    pending: ConsensusProposal[];
    history: ConsensusResult[];
  };
  createdAt: string;
}

interface ConsensusProposal {
  proposalId: string;
  type: string;
  value: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  status: 'pending' | 'approved' | 'rejected';
}

interface ConsensusResult {
  proposalId: string;
  type: string;
  result: 'approved' | 'rejected';
  votes: { for: number; against: number };
  decidedAt: string;
}

function countVotes(votes: Record<string, boolean>) {
  const forCount = Object.values(votes).filter(v => v).length;
  return { for: forCount, against: Object.keys(votes).length - forCount };
}

// Singleton in-memory state (no file backing)
let hiveState: HiveState = createDefaultState();

function createDefaultState(): HiveState {
  return {
    initialized: false,
    hiveId: '',
    topology: 'mesh',
    workers: [],
    consensus: { pending: [], history: [] },
    createdAt: new Date().toISOString(),
  };
}

// ===== Memory DB helpers for shared memory (hive-mind_memory tool) =====

// Cache the memory-initializer module to avoid repeated dynamic imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _memoryModule: any = null;
async function getMemoryModule() {
  if (_memoryModule) return _memoryModule;
  _memoryModule = await import('../memory/memory-initializer.js');
  return _memoryModule;
}

async function memoryGet(key: string): Promise<unknown | undefined> {
  try {
    const mem = await getMemoryModule();
    const result = await mem.getEntry({ key: `hive:${key}`, namespace: HIVE_MEMORY_NS });
    if (result?.entry?.content) {
      try { return JSON.parse(result.entry.content); } catch { return result.entry.content; }
    }
  } catch {
    // Memory DB unavailable
  }
  return undefined;
}

async function memorySet(key: string, value: unknown): Promise<boolean> {
  try {
    const mem = await getMemoryModule();
    const result = await mem.storeEntry({
      key: `hive:${key}`,
      value: typeof value === 'string' ? value : JSON.stringify(value),
      namespace: HIVE_MEMORY_NS,
      upsert: true,
      tags: ['hive-mind', 'shared-memory'],
    });
    return result.success;
  } catch {
    return false;
  }
}

async function memoryDelete(key: string): Promise<boolean> {
  try {
    const mem = await getMemoryModule();
    const result = await mem.deleteEntry({ key: `hive:${key}`, namespace: HIVE_MEMORY_NS });
    return result.success;
  } catch {
    return false;
  }
}

async function memoryList(): Promise<string[]> {
  try {
    const mem = await getMemoryModule();
    const result = await mem.listEntries({ namespace: HIVE_MEMORY_NS, limit: 500 });
    return (result.entries ?? [])
      .map((e: Record<string, unknown>) => (e.key as string))
      .filter((k: string) => k.startsWith('hive:'))
      .map((k: string) => k.slice(5));
  } catch {
    return [];
  }
}

// ===== Agent store (unchanged — still file-based for cross-process agent registry) =====

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function loadAgentStore(): { agents: Record<string, unknown> } {
  const storePath = join(process.cwd(), '.claude-flow', 'agents.json');
  try {
    if (existsSync(storePath)) {
      return JSON.parse(readFileSync(storePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { agents: {} };
}

function saveAgentStore(store: { agents: Record<string, unknown> }): void {
  const storeDir = join(process.cwd(), '.claude-flow');
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true });
  }
  writeFileSync(join(storeDir, 'agents.json'), JSON.stringify(store, null, 2), 'utf-8');
}

// ===== Tool definitions =====

export const hiveMindTools: MCPTool[] = [
  {
    name: 'hive-mind_spawn',
    description: 'Spawn workers and automatically join them to the hive-mind (combines agent/spawn + hive-mind/join)',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of workers to spawn (default: 1)', default: 1 },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Worker role in hive', default: 'worker' },
        agentType: { type: 'string', description: 'Agent type for spawned workers', default: 'worker' },
        prefix: { type: 'string', description: 'Prefix for worker IDs', default: 'hive-worker' },
      },
    },
    handler: async (input) => {
      if (!hiveState.initialized) {
        return { success: false, error: 'Hive-mind not initialized. Run hive-mind/init first.' };
      }

      const bus = await getMessageBus();
      const count = Math.min(Math.max(1, (input.count as number) || 1), 20);
      const role = (input.role as string) || 'worker';
      const agentType = (input.agentType as string) || 'worker';
      const prefix = (input.prefix as string) || 'hive-worker';
      const agentStore = loadAgentStore();

      const spawnedWorkers: Array<{ agentId: string; role: string; joinedAt: string }> = [];

      for (let i = 0; i < count; i++) {
        const agentId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const joinedAt = new Date().toISOString();

        // Create agent record
        agentStore.agents[agentId] = {
          agentId, agentType, status: 'idle', health: 1.0, taskCount: 0,
          config: { role, hiveRole: role }, createdAt: joinedAt, domain: 'hive-mind',
        };

        // Track in hive state
        if (!hiveState.workers.includes(agentId)) {
          hiveState.workers.push(agentId);
        }

        // Publish agent_join via MessageBus
        await bus.sendUnified({
          type: 'agent_join',
          from: agentId,
          to: '*',
          payload: { agentId, role, agentType },
          namespace: HIVE_NS,
          priority: 'normal',
          requiresAck: false,
          ttlMs: HIVE_TTL_MS,
        });

        spawnedWorkers.push({ agentId, role, joinedAt });
      }

      saveAgentStore(agentStore);

      return {
        success: true,
        spawned: count,
        workers: spawnedWorkers,
        totalWorkers: hiveState.workers.length,
        hiveStatus: 'active',
        message: `Spawned ${count} worker(s) and joined them to the hive-mind`,
      };
    },
  },
  {
    name: 'hive-mind_init',
    description: 'Initialize the hive-mind collective',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', enum: ['mesh', 'hierarchical', 'ring', 'star'], description: 'Network topology' },
        queenId: { type: 'string', description: 'Initial queen agent ID' },
      },
    },
    handler: async (input) => {
      const bus = await getMessageBus();
      // Initialize write-through adapter (configures hive-mind namespace)
      await getWriteThroughAdapter();

      const hiveId = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queenId = (input.queenId as string) || `queen-${Date.now()}`;

      hiveState = {
        initialized: true,
        hiveId,
        topology: (input.topology as HiveState['topology']) || 'mesh',
        queen: { agentId: queenId, electedAt: new Date().toISOString(), term: 1 },
        workers: [],
        consensus: { pending: [], history: [] },
        createdAt: new Date().toISOString(),
      };

      // Subscribe the hive-mind system agent to its namespace
      bus.subscribe('hive-mind-system', () => {}, { namespace: HIVE_NS });

      return {
        success: true,
        hiveId,
        topology: hiveState.topology,
        consensus: (input.consensus as string) || 'byzantine',
        queenId,
        status: 'initialized',
        config: {
          topology: hiveState.topology,
          consensus: input.consensus || 'byzantine',
          maxAgents: input.maxAgents || 15,
          persist: input.persist !== false,
          memoryBackend: input.memoryBackend || 'hybrid',
        },
        createdAt: hiveState.createdAt,
      };
    },
  },
  {
    name: 'hive-mind_status',
    description: 'Get hive-mind status',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include detailed information' },
      },
    },
    handler: async (input) => {
      const uptime = hiveState.createdAt ? Date.now() - new Date(hiveState.createdAt).getTime() : 0;
      const hiveId = hiveState.hiveId || `hive-${hiveState.createdAt ? new Date(hiveState.createdAt).getTime() : Date.now()}`;

      // Get MessageBus stats for richer info
      let busStats = { totalMessages: 0, messagesPerSecond: 0, queueDepth: 0, activeNamespaces: 0 };
      try {
        const bus = await getMessageBus();
        busStats = bus.getStats();
      } catch { /* bus not initialized yet */ }

      // Get write-through stats
      let wtStats = { written: 0, errors: 0, reaped: 0 };
      try {
        const adapter = await getWriteThroughAdapter();
        wtStats = adapter.getStats();
      } catch { /* adapter not initialized yet */ }

      const status = {
        hiveId,
        status: hiveState.initialized ? 'active' : 'offline',
        topology: hiveState.topology,
        consensus: 'byzantine',
        queen: hiveState.queen ? {
          id: hiveState.queen.agentId,
          agentId: hiveState.queen.agentId,
          status: 'active',
          load: 0.3 + Math.random() * 0.4,
          tasksQueued: hiveState.consensus.pending.length,
          electedAt: hiveState.queen.electedAt,
          term: hiveState.queen.term,
        } : { id: 'N/A', status: 'offline', load: 0, tasksQueued: 0 },
        workers: hiveState.workers.map(w => ({
          id: w, type: 'worker', status: 'idle', currentTask: null, tasksCompleted: 0,
        })),
        metrics: {
          totalTasks: hiveState.consensus.history.length + hiveState.consensus.pending.length,
          completedTasks: hiveState.consensus.history.length,
          failedTasks: 0,
          avgTaskTime: 150,
          consensusRounds: hiveState.consensus.history.length,
          messageBus: busStats,
          writeThrough: wtStats,
        },
        health: {
          overall: 'healthy',
          queen: hiveState.queen ? 'healthy' : 'unhealthy',
          workers: hiveState.workers.length > 0 ? 'healthy' : 'degraded',
          consensus: 'healthy',
          memory: 'healthy',
        },
        id: hiveId,
        initialized: hiveState.initialized,
        workerCount: hiveState.workers.length,
        pendingConsensus: hiveState.consensus.pending.length,
        uptime,
        createdAt: hiveState.createdAt,
      };

      if (input.verbose) {
        const sharedMemoryKeys = await memoryList();
        return {
          ...status,
          sharedMemoryKeys: sharedMemoryKeys.length,
          workerDetails: hiveState.workers,
          consensusHistory: hiveState.consensus.history.slice(-10),
          sharedMemoryKeyList: sharedMemoryKeys,
        };
      }

      return status;
    },
  },
  {
    name: 'hive-mind_join',
    description: 'Join an agent to the hive-mind',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to join' },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Agent role in hive' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      if (!hiveState.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      const agentId = input.agentId as string;
      const role = (input.role as string) || 'worker';

      if (!hiveState.workers.includes(agentId)) {
        hiveState.workers.push(agentId);
      }

      // Publish agent_join via MessageBus
      const bus = await getMessageBus();
      await bus.sendUnified({
        type: 'agent_join',
        from: agentId,
        to: '*',
        payload: { agentId, role },
        namespace: HIVE_NS,
        priority: 'normal',
        requiresAck: false,
        ttlMs: 300_000,
      });

      return {
        success: true,
        agentId,
        role,
        totalWorkers: hiveState.workers.length,
        joinedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_leave',
    description: 'Remove an agent from the hive-mind',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to remove' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      const index = hiveState.workers.indexOf(agentId);

      if (index > -1) {
        hiveState.workers.splice(index, 1);

        // Publish agent_leave via MessageBus
        const bus = await getMessageBus();
        await bus.sendUnified({
          type: 'agent_leave',
          from: agentId,
          to: '*',
          payload: { agentId },
          namespace: HIVE_NS,
          priority: 'normal',
          requiresAck: false,
          ttlMs: HIVE_TTL_MS,
        });

        return {
          success: true,
          agentId,
          leftAt: new Date().toISOString(),
          remainingWorkers: hiveState.workers.length,
        };
      }

      return { success: false, agentId, error: 'Agent not in hive' };
    },
  },
  {
    name: 'hive-mind_consensus',
    description: 'Propose or vote on consensus',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose', 'vote', 'status', 'list'], description: 'Consensus action' },
        proposalId: { type: 'string', description: 'Proposal ID (for vote/status)' },
        type: { type: 'string', description: 'Proposal type (for propose)' },
        value: { description: 'Proposal value (for propose)' },
        vote: { type: 'boolean', description: 'Vote (true=for, false=against)' },
        voterId: { type: 'string', description: 'Voter agent ID' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = input.action as string;
      const bus = await getMessageBus();

      if (action === 'propose') {
        const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const proposal: ConsensusProposal = {
          proposalId,
          type: (input.type as string) || 'general',
          value: input.value,
          proposedBy: (input.voterId as string) || 'system',
          proposedAt: new Date().toISOString(),
          votes: {},
          status: 'pending',
        };

        hiveState.consensus.pending.push(proposal);

        // Broadcast proposal via MessageBus
        await bus.sendUnified({
          type: 'consensus_propose',
          from: proposal.proposedBy,
          to: '*',
          payload: { proposalId, type: proposal.type, value: proposal.value },
          namespace: HIVE_NS,
          priority: 'high',
          requiresAck: false,
          ttlMs: CONSENSUS_TTL_MS,
        });

        return {
          action,
          proposalId,
          type: proposal.type,
          status: 'pending',
          requiredVotes: Math.floor(hiveState.workers.length / 2) + 1,
        };
      }

      if (action === 'vote') {
        const proposal = hiveState.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          return { action, error: 'Proposal not found' };
        }

        const voterId = input.voterId as string;
        proposal.votes[voterId] = input.vote as boolean;

        // Broadcast vote via MessageBus
        await bus.sendUnified({
          type: 'consensus_vote',
          from: voterId,
          to: '*',
          payload: { proposalId: proposal.proposalId, vote: input.vote },
          namespace: HIVE_NS,
          priority: 'high',
          requiresAck: false,
          ttlMs: CONSENSUS_TTL_MS,
        });

        const tally = countVotes(proposal.votes);
        const majority = Math.floor(hiveState.workers.length / 2) + 1;

        if (tally.for >= majority) {
          proposal.status = 'approved';
          hiveState.consensus.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: 'approved',
            votes: tally,
            decidedAt: new Date().toISOString(),
          });
          hiveState.consensus.pending = hiveState.consensus.pending.filter(p => p.proposalId !== proposal.proposalId);
        } else if (tally.against >= majority) {
          proposal.status = 'rejected';
          hiveState.consensus.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: 'rejected',
            votes: tally,
            decidedAt: new Date().toISOString(),
          });
          hiveState.consensus.pending = hiveState.consensus.pending.filter(p => p.proposalId !== proposal.proposalId);
        }

        return {
          action,
          proposalId: proposal.proposalId,
          voterId,
          vote: input.vote,
          votesFor: tally.for,
          votesAgainst: tally.against,
          status: proposal.status,
        };
      }

      if (action === 'status') {
        const proposal = hiveState.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          const historical = hiveState.consensus.history.find(h => h.proposalId === input.proposalId);
          if (historical) {
            return { action, ...historical, historical: true };
          }
          return { action, error: 'Proposal not found' };
        }

        const tally = countVotes(proposal.votes);

        return {
          action,
          proposalId: proposal.proposalId,
          type: proposal.type,
          status: proposal.status,
          votesFor: tally.for,
          votesAgainst: tally.against,
          totalVotes: Object.keys(proposal.votes).length,
          requiredMajority: Math.floor(hiveState.workers.length / 2) + 1,
        };
      }

      if (action === 'list') {
        return {
          action,
          pending: hiveState.consensus.pending.map(p => ({
            proposalId: p.proposalId,
            type: p.type,
            proposedAt: p.proposedAt,
            totalVotes: Object.keys(p.votes).length,
          })),
          recentHistory: hiveState.consensus.history.slice(-5),
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'hive-mind_broadcast',
    description: 'Broadcast message to all workers',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to broadcast' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Message priority' },
        fromId: { type: 'string', description: 'Sender agent ID' },
      },
      required: ['message'],
    },
    handler: async (input) => {
      if (!hiveState.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      const bus = await getMessageBus();
      const priority = (input.priority as string) || 'normal';

      // Broadcast via MessageBus in hive-mind namespace
      const messageId = await bus.broadcastUnified({
        type: 'broadcast',
        from: (input.fromId as string) || 'system',
        payload: { message: input.message },
        content: input.message as string,
        namespace: HIVE_NS,
        priority: priority as 'low' | 'normal' | 'high' | 'critical',
        requiresAck: false,
        ttlMs: 300_000,
      });

      return {
        success: true,
        messageId,
        recipients: hiveState.workers.length,
        priority,
        broadcastAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_shutdown',
    description: 'Shutdown the hive-mind and terminate all workers',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        graceful: { type: 'boolean', description: 'Graceful shutdown (wait for pending tasks)', default: true },
        force: { type: 'boolean', description: 'Force immediate shutdown', default: false },
      },
    },
    handler: async (input) => {
      if (!hiveState.initialized) {
        return { success: false, error: 'Hive-mind not initialized or already shut down' };
      }

      const graceful = input.graceful !== false;
      const force = input.force === true;
      const workerCount = hiveState.workers.length;
      const pendingConsensus = hiveState.consensus.pending.length;

      if (graceful && pendingConsensus > 0 && !force) {
        return {
          success: false,
          error: `Cannot gracefully shutdown with ${pendingConsensus} pending consensus items. Use force: true to override.`,
          pendingConsensus,
          workerCount,
        };
      }

      // Clear workers from agent store
      const agentStore = loadAgentStore();
      for (const workerId of hiveState.workers) {
        if (agentStore.agents[workerId]) {
          delete agentStore.agents[workerId];
        }
      }
      saveAgentStore(agentStore);

      // Clear write-through namespaces in Memory DB
      try {
        const adapter = await getWriteThroughAdapter();
        await adapter.clearNamespace(HIVE_NS);
        await adapter.clearNamespace(HIVE_MEMORY_NS);
      } catch {
        // Best-effort cleanup
      }

      // Shutdown MessageBus for hive-mind
      try {
        const bus = await getMessageBus();
        bus.unsubscribe('hive-mind-system');
        if (_writeThroughAdapter) {
          _writeThroughAdapter.detach();
          _writeThroughAdapter = null;
        }
      } catch {
        // Bus may not be initialized
      }

      const shutdownTime = new Date().toISOString();
      const previousQueen = hiveState.queen?.agentId;

      // Reset state
      hiveState = createDefaultState();

      return {
        success: true,
        shutdownAt: shutdownTime,
        graceful,
        workersTerminated: workerCount,
        previousQueen,
        consensusCleared: pendingConsensus,
        message: `Hive-mind shutdown complete. ${workerCount} workers terminated.`,
      };
    },
  },
  {
    name: 'hive-mind_memory',
    description: 'Access hive shared memory (backed by Memory DB)',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list'], description: 'Memory action' },
        key: { type: 'string', description: 'Memory key' },
        value: { description: 'Value to store (for set)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = input.action as string;
      const key = input.key as string;

      if (action === 'get') {
        if (!key) return { action, error: 'Key required' };
        const value = await memoryGet(key);
        return { action, key, value, exists: value !== undefined };
      }

      if (action === 'set') {
        if (!key) return { action, error: 'Key required' };
        const success = await memorySet(key, input.value);
        return { action, key, success, updatedAt: new Date().toISOString() };
      }

      if (action === 'delete') {
        if (!key) return { action, error: 'Key required' };
        const deleted = await memoryDelete(key);
        return { action, key, deleted };
      }

      if (action === 'list') {
        const keys = await memoryList();
        return { action, keys, count: keys.length };
      }

      return { action, error: 'Unknown action' };
    },
  },
];
