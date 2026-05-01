/**
 * Swarm MCP Tools for CLI
 *
 * `swarm_init`, `swarm_status`, `swarm_health` route through
 * UnifiedSwarmCoordinator (epic #798, story #803).
 * `swarm_scale` handler logic lives in `./swarm-scale-handler.ts`
 * (epic #798, story #804).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import {
  getSwarmCoordinator,
  isSwarmCoordinatorInitialized,
} from './swarm-coordinator-singleton.js';
import {
  scaleHandler,
  SCALE_STRATEGIES,
  TARGET_AGENTS_MIN,
  TARGET_AGENTS_MAX,
} from './swarm-scale-handler.js';
import { findProjectRoot } from '../services/project-root.js';
import { MOFLO_DIR } from '../services/moflo-paths.js';
import type {
  ConsensusAlgorithm,
  TopologyType,
  CoordinatorConfig,
} from '../swarm/types.js';

// Inputs accepted by the MCP layer (covers Ruflo aliases). The coordinator's
// TopologyType is narrower: 'mesh' | 'hierarchical' | 'centralized' | 'hybrid'.
const TOPOLOGY_MAP: Record<string, TopologyType> = {
  hierarchical: 'hierarchical',
  centralized: 'centralized',
  mesh: 'mesh',
  collective: 'mesh',
  adaptive: 'hybrid',
  'hierarchical-mesh': 'hybrid',
  hybrid: 'hybrid',
};

interface ConsensusMapping {
  algorithm: ConsensusAlgorithm;
  threshold: number;
}

// Ported from Ruflo v3/mcp/tools/swarm-tools.ts. `unanimous`/`weighted`/
// `majority` are the user-facing aliases; the coordinator only speaks
// `byzantine`/`raft`/`gossip`/`paxos`.
const CONSENSUS_MAP: Record<string, ConsensusMapping> = {
  unanimous: { algorithm: 'byzantine', threshold: 1.0 },
  byzantine: { algorithm: 'byzantine', threshold: 1.0 },
  weighted: { algorithm: 'raft', threshold: 0.66 },
  raft: { algorithm: 'raft', threshold: 0.66 },
  majority: { algorithm: 'gossip', threshold: 0.5 },
  gossip: { algorithm: 'gossip', threshold: 0.5 },
  paxos: { algorithm: 'paxos', threshold: 0.66 },
};

const DEFAULT_CONSENSUS: ConsensusMapping = { algorithm: 'raft', threshold: 0.66 };

function mapConsensus(input: unknown): ConsensusMapping {
  if (typeof input === 'string' && input in CONSENSUS_MAP) {
    return CONSENSUS_MAP[input];
  }
  return DEFAULT_CONSENSUS;
}

// Existence-only probe. We never create the dir from a health check —
// that's a write side-effect on a read-only operation.
function probeMemoryBackend(): { ok: boolean; message: string } {
  const dir = join(findProjectRoot(), MOFLO_DIR);
  if (existsSync(dir)) {
    return { ok: true, message: 'Memory backend reachable' };
  }
  return { ok: false, message: `Memory backend dir missing: ${dir}` };
}

export const swarmTools: MCPTool[] = [
  {
    name: 'swarm_init',
    description: 'Initialize a swarm',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: {
          type: 'string',
          description: 'Swarm topology (hierarchical | mesh | adaptive | collective | hierarchical-mesh)',
        },
        maxAgents: { type: 'number', description: 'Maximum number of agents' },
        config: { type: 'object', description: 'Swarm configuration' },
      },
    },
    handler: async (input) => {
      const topologyInput = (input.topology as string) || 'hierarchical-mesh';
      const maxAgents = (input.maxAgents as number) || 15;
      const userConfig = (input.config || {}) as Record<string, unknown>;

      if (!(topologyInput in TOPOLOGY_MAP)) {
        return {
          success: false,
          error: `topology "${topologyInput}" is not in the allowed alias set (${Object.keys(TOPOLOGY_MAP).join(', ')})`,
        };
      }

      const topology = TOPOLOGY_MAP[topologyInput];
      const consensus = mapConsensus(userConfig.consensusMechanism ?? userConfig.consensus);

      // Singleton honors `config` only on first call. Skip the config arg on
      // subsequent calls so swarm_init is idempotent (returns existing swarmId).
      const alreadyInit = isSwarmCoordinatorInitialized();
      const coordinator = alreadyInit
        ? await getSwarmCoordinator()
        : await getSwarmCoordinator({
            topology: { type: topology, maxAgents },
            consensus: {
              algorithm: consensus.algorithm,
              threshold: consensus.threshold,
              timeoutMs: 30000,
              maxRounds: 10,
              requireQuorum: true,
            },
            maxAgents,
          } satisfies Partial<CoordinatorConfig>);

      const state = coordinator.getState();

      return {
        success: true,
        swarmId: state.id.id,
        topology: topologyInput,
        topologyResolved: topology,
        initializedAt: state.id.createdAt.toISOString(),
        configApplied: !alreadyInit,
        config: {
          topology: topologyInput,
          maxAgents,
          currentAgents: state.agents.size,
          communicationProtocol: (userConfig.communicationProtocol as string) || 'message-bus',
          autoScaling: (userConfig.autoScaling as boolean) ?? true,
          consensusAlgorithm: coordinator.getConsensusAlgorithm(),
          consensusThreshold: consensus.threshold,
        },
      };
    },
  },
  {
    name: 'swarm_status',
    description: 'Get swarm status',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID' },
        includeAgents: { type: 'boolean', description: 'Include live agent list' },
        includeMetrics: { type: 'boolean', description: 'Include coordinator metrics' },
        includeTopology: { type: 'boolean', description: 'Include topology state' },
      },
    },
    handler: async (input) => {
      const coordinator = await getSwarmCoordinator();
      const state = coordinator.getState();
      const metrics = coordinator.getMetrics();
      const allAgents = coordinator.getAllAgents();
      const allTasks = coordinator.getAllTasks();

      const counts = { idle: 0, busy: 0, terminated: 0 };
      for (const a of allAgents) {
        if (a.status === 'idle' || a.status === 'busy' || a.status === 'terminated') {
          counts[a.status]++;
        }
      }
      const agentSummary = {
        total: allAgents.length,
        // `active` is the legacy field name kept for `flo status` consumers;
        // it equals `busy` (an agent is "active" iff it's executing a task).
        active: counts.busy,
        idle: counts.idle,
        busy: counts.busy,
        terminated: counts.terminated,
      };

      const response: Record<string, unknown> = {
        swarmId: state.id.id,
        status: state.status,
        topology: coordinator.getTopology(),
        agentCount: allAgents.length,
        taskCount: allTasks.length,
        agentSummary,
        health: state.status === 'running' ? 'healthy' : 'degraded',
        uptime: metrics.uptime,
        startedAt: state.startedAt?.toISOString(),
      };

      if (input.includeAgents) {
        response.agents = allAgents.map(a => ({
          agentId: a.id.id,
          name: a.name,
          agentType: a.type,
          status: a.status,
          health: a.health,
          workload: a.workload,
        }));
      }

      if (input.includeMetrics) {
        response.metrics = metrics;
      }

      if (input.includeTopology) {
        response.topologyState = state.topology;
      }

      return response;
    },
  },
  {
    name: 'swarm_health',
    description: 'Check swarm health status',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to check' },
      },
    },
    handler: async (input) => {
      const coordinator = await getSwarmCoordinator();
      const state = coordinator.getState();
      const metrics = coordinator.getMetrics();
      const agents = coordinator.getAllAgents();

      const checks: Array<{ name: string; status: 'ok' | 'fail'; message: string }> = [];
      const pushCheck = (name: string, ok: boolean, message: string) =>
        checks.push({ name, status: ok ? 'ok' : 'fail', message });

      const coordinatorOk = state.status === 'running';
      pushCheck(
        'coordinator',
        coordinatorOk,
        coordinatorOk ? 'Coordinator running' : `Coordinator status: ${state.status}`,
      );

      const avgHealth = agents.length === 0
        ? 1.0
        : agents.reduce((sum, a) => sum + a.health, 0) / agents.length;
      const agentsOk = agents.length === 0 || avgHealth > 0.7;
      pushCheck(
        'agents',
        agentsOk,
        agents.length === 0
          ? 'Agent pool empty'
          : `Agent pool ${agentsOk ? 'healthy' : 'degraded'} (avg health ${avgHealth.toFixed(2)})`,
      );

      const memProbe = probeMemoryBackend();
      pushCheck('memory', memProbe.ok, memProbe.message);

      // `messagesPerSecond` is a numeric counter on `CoordinatorMetrics` —
      // its presence proves the metrics interval and the bus underneath are
      // both alive. `getMetrics()` itself is a synchronous, non-throwing
      // accessor (verified in unified-coordinator.ts).
      const messagingOk = typeof metrics.messagesPerSecond === 'number';
      pushCheck(
        'messaging',
        messagingOk,
        messagingOk
          ? `Message bus active (${metrics.messagesPerSecond.toFixed(2)} msg/s)`
          : 'Message bus metrics unavailable',
      );

      const overall: 'healthy' | 'degraded' | 'unhealthy' = !coordinatorOk
        ? 'unhealthy'
        : checks.some(c => c.status === 'fail')
          ? 'degraded'
          : 'healthy';

      return {
        status: overall,
        swarmId: (input.swarmId as string) || state.id.id,
        checks,
        checkedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'swarm_scale',
    description: 'Scale swarm agents up or down with gradual / immediate / adaptive strategy',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgents: {
          type: 'number',
          description: `Target number of non-terminated agents (${TARGET_AGENTS_MIN}-${TARGET_AGENTS_MAX})`,
          minimum: TARGET_AGENTS_MIN,
          maximum: TARGET_AGENTS_MAX,
        },
        scaleStrategy: {
          type: 'string',
          enum: [...SCALE_STRATEGIES],
          description: 'Scaling strategy (default: gradual)',
        },
        agentTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent types to spawn (round-robin) and to restrict scale-down candidates to. Defaults to ["worker"].',
        },
        reason: {
          type: 'string',
          description: 'Reason for scaling (audit trail)',
        },
      },
      required: ['targetAgents'],
    },
    handler: async (input) => scaleHandler(input),
  },
];
