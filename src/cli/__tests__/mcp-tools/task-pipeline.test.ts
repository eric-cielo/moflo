/**
 * `task_*` family wired to UnifiedSwarmCoordinator (story #805).
 *
 * Covers the create → assign → status → complete → cancel pipeline. The
 * companion `task-orchestrate.test.ts` covers load-balanced multi-task
 * distribution across agents.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getTaskTool, spawnAgentForTest } from './_helpers.js';

interface TaskShape {
  taskId: string;
  type: string;
  name: string;
  description: string;
  priority: string;
  status: string;
  progress: number;
  assignedTo: string[];
  tags: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: unknown;
}

interface CreateResult extends TaskShape {
  success: boolean;
  error?: string;
}

interface AssignResult {
  success: boolean;
  taskId: string;
  agentId?: string;
  domain?: string;
  assignmentMode?: 'direct' | 'domain';
  queued?: boolean;
  error?: string;
  reason?: string;
}

interface CompleteResult {
  success: boolean;
  taskId: string;
  status?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

interface CancelResult {
  success: boolean;
  taskId: string;
  status?: string;
  cancelledAt?: string;
  reason?: string;
  error?: string;
}

interface ListResult {
  tasks: TaskShape[];
  total: number;
  returned: number;
  filters: Record<string, unknown>;
}

const createTool = getTaskTool('task_create');
const assignTool = getTaskTool('task_assign');
const statusTool = getTaskTool('task_status');
const listTool = getTaskTool('task_list');
const completeTool = getTaskTool('task_complete');
const cancelTool = getTaskTool('task_cancel');

async function create(input: Record<string, unknown>): Promise<CreateResult> {
  return (await createTool.handler(input)) as CreateResult;
}

async function assign(input: Record<string, unknown>): Promise<AssignResult> {
  return (await assignTool.handler(input)) as AssignResult;
}

async function status(input: Record<string, unknown>): Promise<TaskShape & { error?: string }> {
  return (await statusTool.handler(input)) as TaskShape & { error?: string };
}

async function list(input: Record<string, unknown> = {}): Promise<ListResult> {
  return (await listTool.handler(input)) as ListResult;
}

async function complete(input: Record<string, unknown>): Promise<CompleteResult> {
  return (await completeTool.handler(input)) as CompleteResult;
}

async function cancel(input: Record<string, unknown>): Promise<CancelResult> {
  return (await cancelTool.handler(input)) as CancelResult;
}

describe('task_* pipeline — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('runs create → status → complete end-to-end via the coordinator', async () => {
    await spawnAgentForTest({ agentType: 'coder' });

    const created = await create({
      type: 'coding',
      description: 'Implement the thing',
    });
    expect(created.success).toBe(true);
    expect(created.taskId).toMatch(/^task_/);
    // submitTask immediately auto-assigns when an idle agent is available.
    expect(created.status).toBe('assigned');
    expect(created.assignedTo.length).toBe(1);

    // The task is reachable through the live coordinator — not a JSON store.
    const coord = await getSwarmCoordinator();
    expect(coord.getTask(created.taskId)).toBeDefined();

    const stat = await status({ taskId: created.taskId });
    expect(stat.status).toBe('assigned');
    expect(stat.taskId).toBe(created.taskId);

    const completed = await complete({
      taskId: created.taskId,
      result: { ok: true, summary: 'done' },
    });
    expect(completed.success).toBe(true);
    expect(completed.status).toBe('completed');
    expect(completed.result).toEqual({ ok: true, summary: 'done' });

    // Coordinator metrics moved
    expect(coord.getMetrics().completedTasks).toBe(1);
  });

  it('queues a task when no agents are available', async () => {
    const created = await create({
      type: 'research',
      description: 'No agents yet',
    });
    expect(created.success).toBe(true);
    expect(created.status).toBe('queued');
    expect(created.assignedTo).toEqual([]);
  });

  it('rejects missing or invalid type/description without throwing', async () => {
    const noType = await create({ description: 'x' });
    expect(noType.success).toBe(false);
    expect(noType.error).toMatch(/type/);

    const badType = await create({ type: 'sandwich-making', description: 'x' });
    expect(badType.success).toBe(false);

    const noDesc = await create({ type: 'coding' });
    expect(noDesc.success).toBe(false);
    expect(noDesc.error).toMatch(/description/);

    const badPriority = await create({
      type: 'coding',
      description: 'x',
      priority: 'extreme',
    });
    expect(badPriority.success).toBe(false);
    expect(badPriority.error).toMatch(/priority/);
  });

  it('task_assign honors direct agentId targeting', async () => {
    const a1 = await spawnAgentForTest({ agentType: 'coder' });
    const a2 = await spawnAgentForTest({ agentType: 'tester' });

    // Spawn one extra agent so the auto-scheduler doesn't pin the new task to
    // the only idle agent we want to test against.
    void a1;

    const created = await create({ type: 'testing', description: 'Run tests' });
    expect(created.success).toBe(true);

    // First, cancel auto-assignment so we can re-target manually.
    await cancel({ taskId: created.taskId });

    // Re-create a fresh task to test direct assignment.
    const fresh = await create({ type: 'testing', description: 'Round 2' });
    const result = await assign({ taskId: fresh.taskId, agentId: a2 });
    // Direct re-assignment is allowed even if scheduler already picked.
    expect(result.success).toBe(true);
    expect(result.assignmentMode).toBe('direct');
    expect(result.agentId).toBe(a2);

    const coord = await getSwarmCoordinator();
    const live = coord.getTask(fresh.taskId);
    expect(live?.assignedTo?.id).toBe(a2);
  });

  it('task_assign rejects when neither agentId nor domain is provided', async () => {
    const created = await create({ type: 'coding', description: 'x' });
    const result = await assign({ taskId: created.taskId });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agentId.*domain/);
  });

  it('task_assign rejects an unknown agentId', async () => {
    const created = await create({ type: 'coding', description: 'x' });
    const result = await assign({ taskId: created.taskId, agentId: 'agent-ghost' });
    expect(result.success).toBe(false);
    // Handler surfaces the coordinator's reason as `error` to match the
    // shape of agent_terminate / agent_status.
    expect(result.error).toBe('agent_not_found');
  });

  it('task_assign routes through a domain pool when domain is specified', async () => {
    const created = await create({ type: 'analysis', description: 'Domain dispatch' });
    const result = await assign({ taskId: created.taskId, domain: 'security' });

    // Domain pools auto-scale up to maxSize on acquire; first dispatch creates
    // a pooled agent. We assert the contract: domain-mode returns success and
    // either an agentId (assigned) or queued=true (pool exhausted).
    expect(result.success).toBe(true);
    expect(result.assignmentMode).toBe('domain');
    if (result.agentId) {
      const coord = await getSwarmCoordinator();
      const live = coord.getTask(created.taskId);
      expect(live?.assignedTo?.id).toBe(result.agentId);
    } else {
      expect(result.queued).toBe(true);
    }
  });

  it('task_assign rejects an unknown domain string', async () => {
    const created = await create({ type: 'coding', description: 'x' });
    const result = await assign({ taskId: created.taskId, domain: 'sandwich-domain' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/domain/);
  });

  it('task_list filters by status, type, priority, and assignedTo', async () => {
    const agent = await spawnAgentForTest({ agentType: 'coder' });

    const t1 = await create({ type: 'coding', description: 'A', priority: 'high' });
    const t2 = await create({ type: 'research', description: 'B', priority: 'low' });
    void t2;

    // Status filter — t1 was auto-assigned, t2 queued (no researcher agent).
    const assigned = await list({ status: 'assigned' });
    expect(assigned.tasks.find(t => t.taskId === t1.taskId)).toBeDefined();

    const queued = await list({ status: 'queued' });
    expect(queued.tasks.length).toBeGreaterThanOrEqual(1);
    expect(queued.tasks.every(t => t.status === 'queued')).toBe(true);

    // Type filter
    const byType = await list({ type: 'research' });
    expect(byType.tasks.every(t => t.type === 'research')).toBe(true);

    // Priority filter
    const byPriority = await list({ priority: 'high' });
    expect(byPriority.tasks.every(t => t.priority === 'high')).toBe(true);

    // assignedTo filter
    const byAgent = await list({ assignedTo: agent });
    expect(byAgent.tasks.every(t => t.assignedTo.includes(agent))).toBe(true);
  });

  it('task_list paginates with limit/offset and reports total', async () => {
    for (let i = 0; i < 5; i++) {
      await create({ type: 'coding', description: `task-${i}` });
    }
    const page1 = await list({ limit: 2, offset: 0 });
    expect(page1.tasks.length).toBe(2);
    expect(page1.total).toBeGreaterThanOrEqual(5);
    expect(page1.returned).toBe(2);

    const page2 = await list({ limit: 2, offset: 2 });
    expect(page2.tasks.length).toBe(2);

    // No overlap between pages
    const ids1 = page1.tasks.map(t => t.taskId);
    const ids2 = page2.tasks.map(t => t.taskId);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });

  it('task_list supports comma-separated status filter', async () => {
    await spawnAgentForTest({ agentType: 'coder' });
    const created = await create({ type: 'coding', description: 'A' });
    await complete({ taskId: created.taskId });

    await create({ type: 'research', description: 'B' }); // queued

    const result = await list({ status: 'completed,queued' });
    const statuses = new Set(result.tasks.map(t => t.status));
    expect([...statuses].every(s => s === 'completed' || s === 'queued')).toBe(true);
  });

  it('task_complete returns not-found when the task does not exist', async () => {
    const result = await complete({ taskId: 'task-ghost' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found|not_found/);
  });

  it('task_complete is idempotent on already-completed tasks', async () => {
    await spawnAgentForTest({ agentType: 'coder' });
    const created = await create({ type: 'coding', description: 'x' });
    await complete({ taskId: created.taskId, result: { v: 1 } });
    const second = await complete({ taskId: created.taskId, result: { v: 2 } });
    expect(second.success).toBe(true);

    // Output from the first complete should be preserved (no overwrite).
    const stat = await status({ taskId: created.taskId });
    expect(stat.result).toEqual({ v: 1 });
  });

  it('task_cancel transitions to cancelled and records timestamp', async () => {
    await spawnAgentForTest({ agentType: 'coder' });
    const created = await create({ type: 'coding', description: 'will-cancel' });
    const result = await cancel({ taskId: created.taskId, reason: 'changed-my-mind' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.reason).toBe('changed-my-mind');
    expect(() => new Date(result.cancelledAt!).toISOString()).not.toThrow();

    const stat = await status({ taskId: created.taskId });
    expect(stat.status).toBe('cancelled');
  });

  it('task_cancel returns not-found for unknown task ids', async () => {
    const result = await cancel({ taskId: 'task-ghost' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found|not_found/);
  });

  it('rejects malformed taskId on every read/write tool', async () => {
    expect((await status({ taskId: '' })).error).toBeDefined();
    expect((await complete({ taskId: '' })).error).toBeDefined();
    expect((await cancel({ taskId: '' })).error).toBeDefined();
    expect((await assign({ taskId: '' })).error).toBeDefined();
  });
});
