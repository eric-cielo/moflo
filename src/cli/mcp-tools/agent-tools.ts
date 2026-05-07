/**
 * Agent MCP Tools for CLI — all handlers route through UnifiedSwarmCoordinator.
 */

import { randomBytes } from 'node:crypto';
import type { MCPTool } from './types.js';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../services/subagent-bootstrap.js';
import { getSwarmCoordinator } from './swarm-coordinator-singleton.js';
import { liveAgents } from './coordinator-views.js';
import type { AgentType, AgentStatus } from '../swarm/types.js';
import type { AgentDomain } from '../swarm/unified-coordinator.js';

// Model types matching Claude Agent SDK
type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

// Below this floor, agents are reported as 'unhealthy' rather than 'degraded'.
const DEGRADED_FLOOR = 0.3;

type HealthBucket = 'healthy' | 'degraded' | 'unhealthy';

function healthBucket(health: number, threshold: number): HealthBucket {
  if (health >= threshold) return 'healthy';
  if (health >= DEGRADED_FLOOR) return 'degraded';
  return 'unhealthy';
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
  // Claude Code built-ins
  'claude-code-guide', 'general-purpose',
  // Shipped Claude Code agent definitions (.claude/agents/**) — both the
  // canonical `name:` slug and the file basename are accepted.
  'analyze-code-quality', 'api-docs', 'arch-system-design',
  'backend-dev', 'base-template-generator', 'cicd-engineer',
  'code-analyzer', 'database-dev', 'dev-backend-api',
  'dev-database', 'dev-frontend', 'docs-api-openapi',
  'frontend-dev', 'ops-cicd-github', 'planner',
  'security-auditor', 'system-architect', 'test-long-runner',
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
    description: 'Terminate an agent on the coordinator (force / grace-period supported; reassigns active tasks)',
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
    description: 'Get agent status from the coordinator (workload, health, last heartbeat, optional metrics)',
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
    description: 'List coordinator-tracked agents (with status / type / domain filters and pagination)',
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
        min: { type: 'number', description: 'Reported minimum pool size (status echo)' },
        max: { type: 'number', description: 'Reported maximum pool size (status echo)' },
        autoScale: { type: 'boolean', description: 'Reported auto-scale flag (status echo)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = (input.action as string) || 'status';
      const coordinator = await getSwarmCoordinator();
      const live = liveAgents(coordinator);

      if (action === 'status') {
        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        let busyCount = 0;
        let healthSum = 0;
        for (const agent of live) {
          byType[agent.type] = (byType[agent.type] || 0) + 1;
          byStatus[agent.status] = (byStatus[agent.status] || 0) + 1;
          if (agent.status === 'busy') busyCount++;
          healthSum += agent.health;
        }
        const utilization = live.length > 0 ? busyCount / live.length : 0;
        return {
          action,
          poolId: 'agent-pool-default',
          currentSize: live.length,
          minSize: toNonNegativeInt(input.min, 0),
          maxSize: toNonNegativeInt(input.max, 100),
          autoScale: (input.autoScale as boolean) ?? false,
          utilization,
          agents: live.map(a => ({
            id: a.id.id,
            type: a.type,
            status: a.status,
          })),
          id: 'agent-pool-default',
          size: live.length,
          totalAgents: live.length,
          byType,
          byStatus,
          avgHealth: live.length > 0 ? healthSum / live.length : 0,
        };
      }

      if (action === 'scale') {
        const agentTypeRaw = (input.agentType as string) || 'worker';
        const validation = validateAgentType(agentTypeRaw);
        if (!validation.ok) {
          return { action, error: validation.error };
        }
        const agentType = agentTypeRaw as AgentType;
        const targetSize = toNonNegativeInt(input.targetSize, 5);
        const currentForType = live.filter(a => a.type === agentType);
        const delta = targetSize - currentForType.length;
        const added: string[] = [];
        const removed: string[] = [];

        // Sequential awaits — `coordinator.spawnAgent` reads `agentCounter` and
        // `agentDomainMap` between awaits, so parallelizing with Promise.all
        // produces duplicate names and racing domain-slot assignments.
        if (delta > 0) {
          for (let i = 0; i < delta; i++) {
            try {
              const result = await coordinator.spawnAgent({ type: agentType });
              added.push(result.agentId);
            } catch (err) {
              const newSizeOnError = liveAgents(coordinator).filter(a => a.type === agentType).length;
              return {
                action,
                agentType,
                error: (err as Error).message,
                previousSize: currentForType.length,
                targetSize,
                newSize: newSizeOnError,
                added,
                removed,
              };
            }
          }
        } else if (delta < 0) {
          const idleOfType = currentForType
            .filter(a => a.status === 'idle')
            .slice(0, -delta);
          for (const agent of idleOfType) {
            const result = await coordinator.terminateAgent(agent.id.id);
            if (result.terminated) removed.push(result.agentId);
          }
        }

        // Re-query so newSize reflects coordinator truth, not optimistic delta.
        const newSize = liveAgents(coordinator).filter(a => a.type === agentType).length;

        return {
          action,
          agentType,
          previousSize: currentForType.length,
          targetSize,
          newSize,
          added,
          removed,
        };
      }

      if (action === 'drain') {
        const agentTypeFilter = input.agentType as string | undefined;
        const targets = live.filter(a =>
          a.status === 'idle' && (!agentTypeFilter || a.type === agentTypeFilter),
        );
        let drained = 0;
        for (const agent of targets) {
          const result = await coordinator.terminateAgent(agent.id.id);
          if (result.terminated) drained++;
        }
        return {
          action,
          agentType: agentTypeFilter || 'all',
          drained,
          remaining: live.length - drained,
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
      const coordinator = await getSwarmCoordinator();
      const threshold = (input.threshold as number) ?? 0.5;

      if (input.agentId) {
        const agent = coordinator.getAgent(input.agentId as string);
        if (!agent || agent.status === 'terminated') {
          return { agentId: input.agentId, error: 'Agent not found' };
        }
        return {
          agentId: agent.id.id,
          health: agent.health,
          status: agent.status,
          healthy: agent.health >= threshold,
          taskCount: agent.metrics.tasksCompleted + agent.metrics.tasksFailed,
          // lastActivity is initialized at spawn and tracked by the coordinator;
          // the delta is the closest honest "uptime" we have without a separate
          // spawnedAt field on AgentState.
          uptime: Date.now() - agent.metrics.lastActivity.getTime(),
        };
      }

      const live = liveAgents(coordinator);
      let healthSum = 0;
      let cpuSum = 0;
      let memSum = 0;
      let healthyCount = 0;
      let degradedCount = 0;
      let unhealthyCount = 0;
      for (const a of live) {
        healthSum += a.health;
        cpuSum += a.metrics.cpuUsage;
        memSum += a.metrics.memoryUsage;
        const bucket = healthBucket(a.health, threshold);
        if (bucket === 'healthy') healthyCount++;
        else if (bucket === 'degraded') degradedCount++;
        else unhealthyCount++;
      }
      const avgHealth = live.length > 0 ? healthSum / live.length : 1;
      const avgCpu = live.length > 0 ? cpuSum / live.length : 0;
      const avgMemory = live.length > 0 ? memSum / live.length : 0;

      return {
        agents: live.map(a => ({
          id: a.id.id,
          type: a.type,
          health: healthBucket(a.health, threshold),
          uptime: Date.now() - a.metrics.lastActivity.getTime(),
          // Coordinator emits memoryUsage on a 0–100 scale, so anchoring
          // limit at 100 makes the CLI's `used/limit*100` formatter render
          // the percentage as-is — no fake limits.
          memory: { used: a.metrics.memoryUsage, limit: 100 },
          cpu: a.metrics.cpuUsage,
          tasks: {
            active: a.currentTask ? 1 : 0,
            queued: 0,
            completed: a.metrics.tasksCompleted,
            failed: a.metrics.tasksFailed,
          },
          latency: { avg: a.metrics.responseTime, p99: a.metrics.responseTime },
          errors: { count: a.metrics.tasksFailed },
        })),
        overall: {
          healthy: healthyCount,
          degraded: degradedCount,
          unhealthy: unhealthyCount,
          avgCpu,
          avgMemory,
          score: Math.round(avgHealth * 100),
          issues: unhealthyCount,
        },
        total: live.length,
        healthyCount,
        unhealthyCount,
        threshold,
        avgHealth,
        unhealthyAgents: live
          .filter(a => healthBucket(a.health, threshold) === 'unhealthy')
          .map(a => ({
            agentId: a.id.id,
            health: a.health,
            status: a.status,
          })),
      };
    },
  },
];
