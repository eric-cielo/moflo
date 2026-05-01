/**
 * Agent MCP Tools for CLI
 *
 * `agent_spawn`, `agent_list`, `agent_terminate`, `agent_status` route through
 * UnifiedSwarmCoordinator (epic #798, stories #801, #802).
 * TODO(epic-#798): `agent_pool` + `agent_health` are still JSON-store-backed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import { MOFLO_DIR as STORAGE_DIR } from '../services/moflo-paths.js';
import { findProjectRoot } from '../services/project-root.js';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../services/subagent-bootstrap.js';
import { getSwarmCoordinator } from './swarm-coordinator-singleton.js';
import type { AgentType, AgentStatus } from '../swarm/types.js';
import type { AgentDomain } from '../swarm/unified-coordinator.js';

// Storage paths
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

// Model types matching Claude Agent SDK
type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  domain?: string;
  model?: ClaudeModel;  // Model assigned to this agent
  modelRoutedBy?: 'explicit' | 'router' | 'agent-booster' | 'default';  // How model was determined (ADR-026)
}

interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function getAgentDir(): string {
  // findProjectRoot() walks up to the consumer's package.json/.git, so the
  // MCP server still locates `<consumer>/.moflo/agents/` when launched from
  // a working directory that diverges from the user's project root.
  return join(findProjectRoot(), STORAGE_DIR, AGENT_DIR);
}

function getAgentPath(): string {
  return join(getAgentDir(), AGENT_FILE);
}

function ensureAgentDir(): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadAgentStore(): AgentStore {
  try {
    const path = getAgentPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return empty store on error
  }
  return { agents: {}, version: '3.0.0' };
}

function saveAgentStore(store: AgentStore): void {
  ensureAgentDir();
  writeFileSync(getAgentPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// Coordinator's `agentTypeToDomain` falls through to `core` for unknown
// types, so this whitelist is the only gating layer. The slug regex blocks
// typos and shell-injection chars; the Set check pins the surface area to
// the canonical AgentType union plus the shipped `.claude/agents/` slugs.

// Pinning the canonical-13 portion to AgentType makes a TS error fire if the
// union ever drifts ahead of the whitelist.
const CANONICAL_AGENT_TYPES = [
  'coordinator', 'researcher', 'coder', 'analyst', 'architect',
  'tester', 'reviewer', 'optimizer', 'documenter', 'monitor',
  'specialist', 'queen', 'worker',
] as const satisfies readonly AgentType[];

const ALLOWED_AGENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...CANONICAL_AGENT_TYPES,
  // Shipped Claude Code agent definitions (.claude/agents/**)
  'adaptive-coordinator', 'adr-architect', 'aidefence-guardian',
  'analyze-code-quality', 'api-docs', 'arch-system-design',
  'backend-dev', 'base-template-generator', 'benchmark-suite',
  'byzantine-coordinator', 'cicd-engineer', 'claims-authorizer',
  'claude-code-guide', 'code-analyzer', 'code-goal-planner',
  'code-review-swarm', 'collective-intelligence-coordinator',
  'crdt-synchronizer', 'data-ml-model', 'ddd-domain-expert',
  'dev-backend-api', 'docs-api-openapi', 'general-purpose',
  'github-modes', 'goal-planner', 'gossip-coordinator',
  'hierarchical-coordinator', 'injection-analyst', 'issue-tracker',
  'load-balancer', 'memory-specialist', 'mesh-coordinator',
  'ml-developer', 'mobile-dev', 'multi-repo-swarm',
  'ops-cicd-github', 'performance-benchmarker', 'performance-engineer',
  'performance-monitor', 'pii-detector', 'planner',
  'pr-manager', 'production-validator', 'project-board-sync',
  'pseudocode', 'quorum-manager', 'queen-coordinator',
  'raft-manager', 'reasoningbank-learner', 'refinement',
  'release-manager', 'release-swarm', 'repo-architect',
  'resource-allocator', 'safla-neural', 'scout-explorer',
  'security-architect', 'security-architect-aidefence',
  'security-auditor', 'security-manager', 'sona-learning-optimizer',
  'sparc-orchestrator', 'spec-mobile-react-native', 'specification',
  'swarm-issue', 'swarm-memory-manager', 'swarm-pr',
  'sync-coordinator', 'system-architect', 'tdd-london-swarm',
  'test-long-runner', 'topology-optimizer', 'v3-integration-architect',
  'workflow-automation', 'worker-specialist',
]);

const AGENT_TYPE_SLUG_RE = /^[a-z][a-z0-9-]*$/;

export function toNonNegativeInt<D extends number | undefined>(value: unknown, fallback: D): number | D {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export interface AgentTypeValidation {
  ok: boolean;
  error?: string;
}

export function validateAgentType(value: unknown): AgentTypeValidation {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'agentType must be a non-empty string' };
  }
  if (!AGENT_TYPE_SLUG_RE.test(value)) {
    return { ok: false, error: `agentType "${value}" must match ${AGENT_TYPE_SLUG_RE}` };
  }
  if (!ALLOWED_AGENT_TYPES.has(value)) {
    return { ok: false, error: `agentType "${value}" is not in the allowed agent-type whitelist` };
  }
  return { ok: true };
}

// Default model mappings for agent types (can be overridden)
const AGENT_TYPE_MODEL_DEFAULTS: Record<string, ClaudeModel> = {
  // Complex agents → opus
  'architect': 'opus',
  'security-architect': 'opus',
  'system-architect': 'opus',
  'core-architect': 'opus',
  // Medium complexity → sonnet
  'coder': 'sonnet',
  'reviewer': 'sonnet',
  'researcher': 'sonnet',
  'tester': 'sonnet',
  'analyst': 'sonnet',
  // Simple/fast agents → haiku
  'formatter': 'haiku',
  'linter': 'haiku',
  'documenter': 'haiku',
};

// Lazy-loaded model router
let modelRouterInstance: Awaited<ReturnType<typeof import('../movector/model-router.js').getModelRouter>> | null = null;

async function getModelRouter() {
  if (!modelRouterInstance) {
    try {
      const { getModelRouter } = await import('../movector/model-router.js');
      modelRouterInstance = getModelRouter();
    } catch (e) {
      // Log but don't fail - model router is optional
      console.error('[agent-tools] Model router load failed:', (e as Error).message);
    }
  }
  return modelRouterInstance;
}

/**
 * Determine model for agent based on (ADR-026 3-tier routing):
 * 1. Explicit model in config
 * 2. Enhanced task-based routing with Agent Booster AST (if task provided)
 * 3. Agent type defaults
 * 4. Fallback to sonnet
 */
async function determineAgentModel(
  agentType: string,
  config: Record<string, unknown>,
  task?: string
): Promise<{
  model: ClaudeModel;
  routedBy: 'explicit' | 'router' | 'agent-booster' | 'default';
  canSkipLLM?: boolean;
  agentBoosterIntent?: string;
  tier?: 1 | 2 | 3;
}> {
  // 1. Explicit model in config
  if (config.model && ['haiku', 'sonnet', 'opus', 'inherit'].includes(config.model as string)) {
    return { model: config.model as ClaudeModel, routedBy: 'explicit' };
  }

  // 2. Enhanced task-based routing with Agent Booster AST
  if (task) {
    try {
      // Try enhanced router first (includes Agent Booster detection)
      const { getEnhancedModelRouter } = await import('../movector/enhanced-model-router.js');
      const enhancedRouter = getEnhancedModelRouter();
      const routeResult = await enhancedRouter.route(task, { filePath: config.filePath as string });

      if (routeResult.tier === 1 && routeResult.canSkipLLM) {
        // Agent Booster can handle this task
        return {
          model: 'haiku', // Use haiku as fallback if AB fails
          routedBy: 'agent-booster',
          canSkipLLM: true,
          agentBoosterIntent: routeResult.agentBoosterIntent?.type,
          tier: 1,
        };
      }

      return {
        model: routeResult.model!,
        routedBy: 'router',
        tier: routeResult.tier,
      };
    } catch {
      // Enhanced router not available, try basic router
      const router = await getModelRouter();
      if (router) {
        try {
          const result = await router.route(task);
          return { model: result.model, routedBy: 'router' };
        } catch {
          // Fall through to defaults on router error
        }
      }
    }
  }

  // 3. Agent type defaults
  const defaultModel = AGENT_TYPE_MODEL_DEFAULTS[agentType];
  if (defaultModel) {
    return { model: defaultModel, routedBy: 'default' };
  }

  // 4. Fallback to sonnet (balanced)
  return { model: 'sonnet', routedBy: 'default' };
}

export const agentTools: MCPTool[] = [
  {
    name: 'agent_spawn',
    description: 'Spawn a new agent with intelligent model selection',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: { type: 'string', description: 'Type of agent to spawn' },
        agentId: { type: 'string', description: 'Optional custom agent ID' },
        config: { type: 'object', description: 'Agent configuration' },
        domain: { type: 'string', description: 'Agent domain' },
        model: {
          type: 'string',
          enum: ['haiku', 'sonnet', 'opus', 'inherit'],
          description: 'Claude model to use (haiku=fast/cheap, sonnet=balanced, opus=most capable)'
        },
        task: { type: 'string', description: 'Task description for intelligent model routing' },
      },
      required: ['agentType'],
    },
    handler: async (input) => {
      const validation = validateAgentType(input.agentType);
      if (!validation.ok) {
        return {
          success: false,
          error: validation.error,
          agentType: input.agentType,
        };
      }
      const agentType = input.agentType as string;
      const config = (input.config as Record<string, unknown>) || {};

      if (input.model) {
        config.model = input.model;
      }

      const task = (input.task as string) || (config.task as string) || undefined;

      const routingResult = await determineAgentModel(agentType, config, task);

      // Math.random().toString(36) was observably colliding under burst spawns.
      const agentId = `agent-${agentType}-${randomBytes(12).toString('hex')}`;

      const capabilities = Array.isArray(config.capabilities)
        ? (config.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
        : undefined;

      const coordinator = await getSwarmCoordinator();
      let spawned: { agentId: string; domain: AgentDomain; status: string; spawned: boolean };
      try {
        spawned = await coordinator.spawnAgent({
          id: agentId,
          type: agentType as AgentType,
          name: (config.name as string) || agentId,
          capabilities,
          domain: input.domain as AgentDomain | undefined,
          metadata: {
            ...(config as Record<string, unknown>),
            model: routingResult.model,
            modelRoutedBy: routingResult.routedBy,
            bootstrap: SUBAGENT_BOOTSTRAP_DIRECTIVE,
          },
        });
      } catch (err) {
        return {
          success: false,
          agentId,
          agentType,
          error: (err as Error).message,
        };
      }

      const response: Record<string, unknown> = {
        success: true,
        agentId: spawned.agentId,
        agentType,
        domain: spawned.domain,
        status: spawned.status,
        spawned: spawned.spawned,
        model: routingResult.model,
        modelRoutedBy: routingResult.routedBy,
        bootstrap: SUBAGENT_BOOTSTRAP_DIRECTIVE,
        createdAt: new Date().toISOString(),
      };

      if (routingResult.canSkipLLM) {
        response.canSkipLLM = true;
        response.agentBoosterIntent = routingResult.agentBoosterIntent;
        response.tier = routingResult.tier;
        response.note = `Agent Booster can handle "${routingResult.agentBoosterIntent}" - use agent_booster_edit_file MCP tool`;
      } else if (routingResult.tier) {
        response.tier = routingResult.tier;
      }

      return response;
    },
  },
  {
    name: 'agent_terminate',
    description: 'Terminate an agent',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent to terminate' },
        force: { type: 'boolean', description: 'Force immediate termination' },
        reason: { type: 'string', description: 'Reason for termination (audit trail)' },
        gracePeriodMs: { type: 'number', description: 'Grace period before forcing (ms)' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      if (typeof agentId !== 'string' || !agentId) {
        return { success: false, agentId, error: 'agentId must be a non-empty string' };
      }

      const coordinator = await getSwarmCoordinator();
      try {
        const result = await coordinator.terminateAgent(agentId, {
          force: input.force as boolean | undefined,
          reason: input.reason as string | undefined,
          gracePeriodMs: input.gracePeriodMs as number | undefined,
        });

        if (!result.terminated) {
          return { success: false, agentId, error: result.reason || 'Agent not found' };
        }

        return {
          success: true,
          agentId: result.agentId,
          terminated: true,
          tasksReassigned: result.tasksReassigned ?? 0,
          reason: result.reason,
          terminatedAt: new Date().toISOString(),
        };
      } catch (err) {
        return { success: false, agentId, error: (err as Error).message };
      }
    },
  },
  {
    name: 'agent_status',
    description: 'Get agent status',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent' },
        includeMetrics: { type: 'boolean', description: 'Include AgentMetrics in response' },
        includeHistory: { type: 'boolean', description: 'Include task counters from metrics' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      if (typeof agentId !== 'string' || !agentId) {
        return { agentId, status: 'not_found', error: 'agentId must be a non-empty string' };
      }

      const coordinator = await getSwarmCoordinator();
      const agent = coordinator.getAgent(agentId);
      if (!agent) {
        return { agentId, status: 'not_found', error: 'Agent not found' };
      }

      const response: Record<string, unknown> = {
        agentId: agent.id.id,
        agentType: agent.type,
        name: agent.name,
        status: agent.status,
        health: agent.health,
        workload: agent.workload,
        domain: coordinator.getDomainForAgent(agentId),
        currentTask: agent.currentTask?.id,
        lastHeartbeat: agent.lastHeartbeat.toISOString(),
        taskCount: agent.metrics.tasksCompleted + agent.metrics.tasksFailed,
      };

      if (input.includeMetrics) {
        response.metrics = {
          ...agent.metrics,
          lastActivity: agent.metrics.lastActivity.toISOString(),
        };
      }

      if (input.includeHistory) {
        response.history = {
          tasksCompleted: agent.metrics.tasksCompleted,
          tasksFailed: agent.metrics.tasksFailed,
          successRate: agent.metrics.successRate,
        };
      }

      return response;
    },
  },
  {
    name: 'agent_list',
    description: 'List all agents',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (idle/busy/...)' },
        agentType: { type: 'string', description: 'Filter by agent type' },
        domain: { type: 'string', description: 'Filter by domain' },
        limit: { type: 'number', description: 'Max results to return' },
        offset: { type: 'number', description: 'Skip first N results' },
      },
    },
    handler: async (input) => {
      const coordinator = await getSwarmCoordinator();
      const all = coordinator.listAgents({
        status: input.status as AgentStatus | undefined,
        type: input.agentType as AgentType | undefined,
        domain: input.domain as AgentDomain | undefined,
      });

      const offset = toNonNegativeInt(input.offset, 0);
      const limit = toNonNegativeInt(input.limit, undefined);
      const sliced = limit === undefined ? all.slice(offset) : all.slice(offset, offset + limit);

      // Rename `type` → `agentType` so list/status/spawn share one field name.
      const projected = sliced.map(({ type, ...rest }) => ({ ...rest, agentType: type }));

      return {
        agents: projected,
        total: all.length,
        returned: projected.length,
        filters: {
          status: input.status,
          agentType: input.agentType,
          domain: input.domain,
          limit,
          offset,
        },
      };
    },
  },
  {
    name: 'agent_pool',
    description: 'Manage agent pool',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'scale', 'drain', 'fill'], description: 'Pool action' },
        targetSize: { type: 'number', description: 'Target pool size (for scale action)' },
        agentType: { type: 'string', description: 'Agent type filter' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const store = loadAgentStore();
      const agents = Object.values(store.agents).filter(a => a.status !== 'terminated');
      const action = (input.action as string) || 'status';  // Default to status

      if (action === 'status') {
        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        for (const agent of agents) {
          byType[agent.agentType] = (byType[agent.agentType] || 0) + 1;
          byStatus[agent.status] = (byStatus[agent.status] || 0) + 1;
        }
        const idleAgents = agents.filter(a => a.status === 'idle').length;
        const busyAgents = agents.filter(a => a.status === 'busy').length;
        const utilization = agents.length > 0 ? busyAgents / agents.length : 0;
        return {
          action,
          // CLI expected fields
          poolId: 'agent-pool-default',
          currentSize: agents.length,
          minSize: (input.min as number) || 0,
          maxSize: (input.max as number) || 100,
          autoScale: (input.autoScale as boolean) ?? false,
          utilization,
          agents: agents.map(a => ({
            id: a.agentId,
            type: a.agentType,
            status: a.status,
          })),
          // Additional fields
          id: 'agent-pool-default',
          size: agents.length,
          totalAgents: agents.length,
          byType,
          byStatus,
          avgHealth: agents.length > 0 ? agents.reduce((sum, a) => sum + a.health, 0) / agents.length : 0,
        };
      }

      if (action === 'scale') {
        const targetSize = (input.targetSize as number) || 5;
        const agentType = (input.agentType as string) || 'worker';
        const currentSize = agents.filter(a => a.agentType === agentType).length;
        const delta = targetSize - currentSize;
        const added: string[] = [];
        const removed: string[] = [];

        if (delta > 0) {
          for (let i = 0; i < delta; i++) {
            const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            store.agents[agentId] = {
              agentId,
              agentType,
              status: 'idle',
              health: 1.0,
              taskCount: 0,
              config: {},
              createdAt: new Date().toISOString(),
            };
            added.push(agentId);
          }
        } else if (delta < 0) {
          const toRemove = agents.filter(a => a.agentType === agentType && a.status === 'idle').slice(0, -delta);
          for (const agent of toRemove) {
            store.agents[agent.agentId].status = 'terminated';
            removed.push(agent.agentId);
          }
        }

        saveAgentStore(store);
        return {
          action,
          agentType,
          previousSize: currentSize,
          targetSize,
          newSize: currentSize + delta,
          added,
          removed,
        };
      }

      if (action === 'drain') {
        const agentType = input.agentType as string;
        let drained = 0;
        for (const agent of agents) {
          if (!agentType || agent.agentType === agentType) {
            if (agent.status === 'idle') {
              store.agents[agent.agentId].status = 'terminated';
              drained++;
            }
          }
        }
        saveAgentStore(store);
        return {
          action,
          agentType: agentType || 'all',
          drained,
          remaining: agents.length - drained,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'agent_health',
    description: 'Check agent health',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Specific agent ID (optional)' },
        threshold: { type: 'number', description: 'Health threshold (0-1)' },
      },
    },
    handler: async (input) => {
      const store = loadAgentStore();
      const agents = Object.values(store.agents).filter(a => a.status !== 'terminated');
      const threshold = (input.threshold as number) || 0.5;

      if (input.agentId) {
        const agent = store.agents[input.agentId as string];
        if (agent) {
          return {
            agentId: agent.agentId,
            health: agent.health,
            status: agent.status,
            healthy: agent.health >= threshold,
            taskCount: agent.taskCount,
            uptime: Date.now() - new Date(agent.createdAt).getTime(),
          };
        }
        return { agentId: input.agentId, error: 'Agent not found' };
      }

      const healthyAgents = agents.filter(a => a.health >= threshold);
      const degradedAgents = agents.filter(a => a.health >= 0.3 && a.health < threshold);
      const unhealthyAgents = agents.filter(a => a.health < 0.3);
      const avgHealth = agents.length > 0 ? agents.reduce((sum, a) => sum + a.health, 0) / agents.length : 1;
      const avgCpu = agents.length > 0 ? 35 + Math.random() * 30 : 0; // Simulated CPU
      const avgMemory = avgHealth * 0.6; // Correlated with health

      return {
        // CLI expected fields
        agents: agents.map(a => {
          const uptime = Date.now() - new Date(a.createdAt).getTime();
          return {
            id: a.agentId,
            type: a.agentType,
            health: a.health >= threshold ? 'healthy' : (a.health >= 0.3 ? 'degraded' : 'unhealthy'),
            uptime,
            memory: { used: Math.floor(256 * (1 - a.health * 0.3)), limit: 512 },
            cpu: 20 + Math.floor(a.health * 40),
            tasks: { active: a.taskCount > 0 ? 1 : 0, queued: 0, completed: a.taskCount, failed: 0 },
            latency: { avg: 50 + Math.floor((1 - a.health) * 100), p99: 150 + Math.floor((1 - a.health) * 200) },
            errors: { count: a.health < threshold ? 1 : 0 },
          };
        }),
        overall: {
          healthy: healthyAgents.length,
          degraded: degradedAgents.length,
          unhealthy: unhealthyAgents.length,
          avgCpu,
          avgMemory,
          score: Math.round(avgHealth * 100),
          issues: unhealthyAgents.length,
        },
        // Additional fields
        total: agents.length,
        healthyCount: healthyAgents.length,
        unhealthyCount: unhealthyAgents.length,
        threshold,
        avgHealth,
        unhealthyAgents: unhealthyAgents.map(a => ({
          agentId: a.agentId,
          health: a.health,
          status: a.status,
        })),
      };
    },
  },
];
