/**
 * Task MCP tool surface backed by UnifiedSwarmCoordinator.
 */

import { randomBytes } from 'node:crypto';
import type { MCPTool } from './types.js';
import { getSwarmCoordinator } from './swarm-coordinator-singleton.js';
import { toNonNegativeInt } from './agent-tools.js';
import type {
  TaskDefinition,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '../swarm/types.js';
import type { AgentDomain } from '../swarm/unified-coordinator.js';

const TASK_TYPES: ReadonlySet<TaskType> = new Set([
  'research', 'analysis', 'coding', 'testing', 'review',
  'documentation', 'coordination', 'consensus', 'custom',
]);

const TASK_PRIORITIES: ReadonlySet<TaskPriority> = new Set([
  'critical', 'high', 'normal', 'low', 'background',
]);

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'created', 'queued', 'assigned', 'running', 'paused',
  'completed', 'failed', 'cancelled', 'timeout',
]);

const AGENT_DOMAINS: ReadonlySet<AgentDomain> = new Set([
  'queen', 'security', 'core', 'integration', 'support',
]);

// Pin the projection's timeout default rather than reading
// coordinator.config.taskTimeoutMs so the MCP-side shape stays stable across
// coordinator re-config.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

const PROGRESS_BY_STATUS: Record<TaskStatus, number> = {
  created: 0,
  queued: 0,
  assigned: 10,
  running: 50,
  paused: 50,
  completed: 100,
  failed: 0,
  cancelled: 0,
  timeout: 0,
};

interface TaskIdValidation {
  ok: boolean;
  taskId: string;
  error?: string;
}

function validateTaskId(input: Record<string, unknown>): TaskIdValidation {
  const taskId = input.taskId as string;
  if (typeof taskId !== 'string' || !taskId) {
    return { ok: false, taskId: taskId ?? '', error: 'taskId must be a non-empty string' };
  }
  return { ok: true, taskId };
}

interface TaskShape {
  taskId: string;
  type: TaskType;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  progress: number;
  assignedTo: string[];
  tags: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: unknown;
}

function projectTask(task: TaskDefinition): TaskShape {
  // Coordinator has no numeric progress; derive from status so the MCP shape
  // matches what the legacy JSON-store API exposed.
  const tags = Array.isArray(task.metadata?.tags)
    ? (task.metadata.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  return {
    taskId: task.id.id,
    type: task.type,
    name: task.name,
    description: task.description,
    priority: task.priority,
    status: task.status,
    progress: PROGRESS_BY_STATUS[task.status] ?? 0,
    assignedTo: task.assignedTo ? [task.assignedTo.id] : [],
    tags,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt ? task.startedAt.toISOString() : null,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    result: task.output,
  };
}

function buildTaskInput(input: Record<string, unknown>): {
  ok: true;
  task: Omit<TaskDefinition, 'id' | 'status' | 'createdAt'>;
} | { ok: false; error: string } {
  const type = input.type as string;
  if (!type || !TASK_TYPES.has(type as TaskType)) {
    return {
      ok: false,
      error: `type must be one of: ${[...TASK_TYPES].join(', ')}`,
    };
  }

  const description = input.description as string;
  if (typeof description !== 'string' || description.length === 0) {
    return { ok: false, error: 'description must be a non-empty string' };
  }

  const priorityRaw = (input.priority as string) || 'normal';
  if (!TASK_PRIORITIES.has(priorityRaw as TaskPriority)) {
    return {
      ok: false,
      error: `priority must be one of: ${[...TASK_PRIORITIES].join(', ')}`,
    };
  }

  const tags = Array.isArray(input.tags)
    ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  const name = (input.name as string) || `${type}-${randomBytes(4).toString('hex')}`;
  const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
    ? input.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxRetries = typeof input.maxRetries === 'number' && input.maxRetries >= 0
    ? Math.floor(input.maxRetries)
    : DEFAULT_MAX_RETRIES;

  return {
    ok: true,
    task: {
      type: type as TaskType,
      name,
      description,
      priority: priorityRaw as TaskPriority,
      dependencies: [],
      input: input.input ?? null,
      timeoutMs,
      retries: 0,
      maxRetries,
      metadata: {
        tags,
        ...(input.metadata && typeof input.metadata === 'object'
          ? input.metadata as Record<string, unknown>
          : {}),
      },
    },
  };
}

export const taskTools: MCPTool[] = [
  {
    name: 'task_create',
    description: 'Create a new task and submit it to the coordinator',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Task type (${[...TASK_TYPES].join(' | ')})` },
        name: { type: 'string', description: 'Optional human-readable name' },
        description: { type: 'string', description: 'Task description' },
        priority: { type: 'string', description: `Task priority (${[...TASK_PRIORITIES].join(' | ')})` },
        tags: { type: 'array', items: { type: 'string' }, description: 'Task tags' },
        timeoutMs: { type: 'number', description: 'Task timeout (ms)' },
        maxRetries: { type: 'number', description: 'Max retry attempts' },
        input: { description: 'Task input payload (any shape)' },
        metadata: { type: 'object', description: 'Additional metadata merged into task.metadata' },
      },
      required: ['type', 'description'],
    },
    handler: async (input) => {
      const built = buildTaskInput(input);
      if (!built.ok) {
        return { success: false, error: built.error };
      }

      const coordinator = await getSwarmCoordinator();
      try {
        const taskId = await coordinator.submitTask(built.task);
        const task = coordinator.getTask(taskId);
        if (!task) {
          return { success: false, error: 'Task creation succeeded but task not found' };
        }
        return { success: true, ...projectTask(task) };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  },
  {
    name: 'task_status',
    description: 'Get task status from the coordinator',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const v = validateTaskId(input);
      if (!v.ok) return { taskId: v.taskId, status: 'not_found', error: v.error };
      const coordinator = await getSwarmCoordinator();
      const task = coordinator.getTask(v.taskId);
      if (!task) {
        return { taskId: v.taskId, status: 'not_found', error: 'task_not_found' };
      }
      return projectTask(task);
    },
  },
  {
    name: 'task_list',
    description: 'List tasks with filters',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (comma-separated for multiple)' },
        type: { type: 'string', description: 'Filter by task type' },
        assignedTo: { type: 'string', description: 'Filter by assigned agent ID' },
        priority: { type: 'string', description: 'Filter by priority' },
        limit: { type: 'number', description: 'Max tasks to return (default 50)' },
        offset: { type: 'number', description: 'Skip first N results' },
      },
    },
    handler: async (input) => {
      const coordinator = await getSwarmCoordinator();
      let tasks = coordinator.getAllTasks();

      if (input.status) {
        const statuses = (input.status as string).split(',').map(s => s.trim());
        tasks = tasks.filter(t => statuses.includes(t.status));
      }
      if (input.type) {
        tasks = tasks.filter(t => t.type === input.type);
      }
      if (input.assignedTo) {
        tasks = tasks.filter(t => t.assignedTo?.id === input.assignedTo);
      }
      if (input.priority) {
        tasks = tasks.filter(t => t.priority === input.priority);
      }

      tasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const total = tasks.length;
      const offset = toNonNegativeInt(input.offset, 0);
      const limitInput = toNonNegativeInt(input.limit, undefined);
      const limit = limitInput && limitInput > 0 ? limitInput : 50;
      const sliced = tasks.slice(offset, offset + limit);

      return {
        tasks: sliced.map(projectTask),
        total,
        returned: sliced.length,
        filters: {
          status: input.status,
          type: input.type,
          assignedTo: input.assignedTo,
          priority: input.priority,
          limit,
          offset,
        },
      };
    },
  },
  {
    name: 'task_complete',
    description: 'Mark a task as completed and record its result',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        result: { description: 'Task result payload (any shape)' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const v = validateTaskId(input);
      if (!v.ok) return { success: false, taskId: v.taskId, error: v.error };
      const coordinator = await getSwarmCoordinator();
      const outcome = await coordinator.completeTask(v.taskId, input.result);
      if (!outcome.completed) {
        return { success: false, taskId: v.taskId, error: outcome.reason };
      }
      const task = coordinator.getTask(v.taskId);
      return {
        success: true,
        taskId: v.taskId,
        status: task?.status ?? 'completed',
        completedAt: task?.completedAt?.toISOString() ?? new Date().toISOString(),
        result: task?.output,
      };
    },
  },
  {
    name: 'task_assign',
    description: 'Assign a task to a specific agent or to a domain pool',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to assign' },
        agentId: { type: 'string', description: 'Agent ID for direct assignment' },
        domain: { type: 'string', description: `Domain to assign through (${[...AGENT_DOMAINS].join(' | ')})` },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const v = validateTaskId(input);
      if (!v.ok) return { success: false, taskId: v.taskId, error: v.error };
      const coordinator = await getSwarmCoordinator();

      const agentId = input.agentId as string | undefined;
      const domain = input.domain as string | undefined;

      if (!agentId && !domain) {
        return { success: false, taskId: v.taskId, error: 'Either agentId or domain must be provided' };
      }
      if (agentId && domain) {
        return { success: false, taskId: v.taskId, error: 'Provide agentId or domain, not both' };
      }

      try {
        if (agentId) {
          const result = await coordinator.assignTaskToAgent(v.taskId, agentId);
          if (!result.assigned) {
            return { success: false, taskId: v.taskId, agentId, error: result.reason };
          }
          return { success: true, taskId: v.taskId, agentId, assignmentMode: 'direct' };
        }

        if (!AGENT_DOMAINS.has(domain as AgentDomain)) {
          return {
            success: false,
            taskId: v.taskId,
            error: `domain must be one of: ${[...AGENT_DOMAINS].join(', ')}`,
          };
        }
        const assignedAgent = await coordinator.assignTaskToDomain(v.taskId, domain as AgentDomain);
        if (!assignedAgent) {
          return {
            success: true,
            taskId: v.taskId,
            domain,
            assignmentMode: 'domain',
            queued: true,
            reason: 'no_available_agents',
          };
        }
        return {
          success: true,
          taskId: v.taskId,
          domain,
          agentId: assignedAgent,
          assignmentMode: 'domain',
        };
      } catch (err) {
        return { success: false, taskId: v.taskId, error: (err as Error).message };
      }
    },
  },
  {
    name: 'task_orchestrate',
    description: 'Submit multiple tasks in one call; load-balanced across available agents',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of task definitions (same shape as task_create input)',
          items: { type: 'object' },
        },
      },
      required: ['tasks'],
    },
    handler: async (input) => {
      const tasks = input.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { success: false, error: 'tasks must be a non-empty array' };
      }

      const coordinator = await getSwarmCoordinator();
      const accepted: TaskShape[] = [];
      const rejected: Array<{ index: number; error: string }> = [];

      // Sequential on purpose: coordinator's `assignTask` reads
      // `getAvailableAgents()` then awaits a `messageBus.send` before flipping
      // the chosen agent to 'busy'. Parallelizing this loop with Promise.all
      // lets two submits observe the same idle agent and break the
      // load-balancing AC ("5 tasks across 3 agents → no agent gets >2").
      for (let i = 0; i < tasks.length; i++) {
        const built = buildTaskInput(tasks[i] as Record<string, unknown>);
        if (!built.ok) {
          rejected.push({ index: i, error: built.error });
          continue;
        }
        try {
          const taskId = await coordinator.submitTask(built.task);
          const task = coordinator.getTask(taskId);
          if (task) accepted.push(projectTask(task));
        } catch (err) {
          rejected.push({ index: i, error: (err as Error).message });
        }
      }

      const assignedCount = accepted.filter(t => t.assignedTo.length > 0).length;
      const queuedCount = accepted.length - assignedCount;

      return {
        success: rejected.length === 0,
        submitted: accepted.length,
        assigned: assignedCount,
        queued: queuedCount,
        rejected: rejected.length,
        tasks: accepted,
        errors: rejected,
      };
    },
  },
  {
    name: 'task_cancel',
    description: 'Cancel a task',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        reason: { type: 'string', description: 'Cancellation reason' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const v = validateTaskId(input);
      if (!v.ok) return { success: false, taskId: v.taskId, error: v.error };
      const coordinator = await getSwarmCoordinator();
      const before = coordinator.getTask(v.taskId);
      if (!before) {
        return { success: false, taskId: v.taskId, error: 'task_not_found' };
      }
      try {
        await coordinator.cancelTask(v.taskId);
        const after = coordinator.getTask(v.taskId);
        return {
          success: true,
          taskId: v.taskId,
          status: after?.status ?? 'cancelled',
          cancelledAt: after?.completedAt?.toISOString() ?? new Date().toISOString(),
          reason: (input.reason as string) || 'Cancelled by user',
        };
      } catch (err) {
        return { success: false, taskId: v.taskId, error: (err as Error).message };
      }
    },
  },
];

// Validation helpers exported for test reuse.
export { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES, AGENT_DOMAINS };
