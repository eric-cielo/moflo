/**
 * Issue #1329 — swarm task durability.
 *
 * Agents and topology already survived an MCP-server restart; tasks did not,
 * so a caller that submitted work and later polled `task_status` got nothing
 * back across a restart boundary. These cover the write-through, the hydrate,
 * the debounce, and the retention bound that keeps persisted history from
 * silently consuming the coordinator's `maxTasks` budget.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  _setSwarmPersistenceForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import {
  MAX_PERSISTED_TERMINAL_TASKS,
  SWARM_AGENTS_NS,
  SWARM_TASKS_NS,
  SwarmPersistence,
  isTerminalTaskStatus,
} from '../../swarm/swarm-persistence.js';
import type { TaskDefinition, TaskStatus } from '../../swarm/types.js';
import { createInMemoryPersistence } from './_in-memory-persistence.js';
import { getAgentTool, getTaskTool, spawnAgentForTest } from '../mcp-tools/_helpers.js';

interface TaskShape {
  taskId: string;
  status: string;
  description: string;
  assignedTo: string[];
  result?: unknown;
}

function taskRows(backend: ReturnType<typeof createInMemoryPersistence>) {
  return Array.from(backend.rows.values()).filter(r => r.namespace === SWARM_TASKS_NS);
}

/**
 * Task writes are microtask-debounced and fire-and-forget, so a test that
 * reads immediately after the handler returns is racing the flush. Yield until
 * the expected row count appears (capped), same shape as the topology test.
 */
async function waitForTaskRows(
  backend: ReturnType<typeof createInMemoryPersistence>,
  atLeast: number,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (taskRows(backend).length >= atLeast) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function createTask(description: string, extra: Record<string, unknown> = {}) {
  return (await getTaskTool('task_create').handler({
    type: 'coding',
    description,
    ...extra,
  })) as TaskShape & { success: boolean; error?: string };
}

/** Minimal terminal task, for driving the persistence layer without a coordinator. */
function terminalTask(index: number, status: TaskStatus, completedAt: Date): TaskDefinition {
  return {
    id: { id: `task_fixture_${index}`, swarmId: 'swarm_fixture', sequence: index, priority: 'normal' },
    type: 'coding',
    name: `fixture-${index}`,
    description: `fixture task ${index}`,
    priority: 'normal',
    status,
    dependencies: [],
    input: null,
    createdAt: new Date(completedAt.getTime() - 1000),
    completedAt,
    timeoutMs: 1000,
    retries: 0,
    maxRetries: 3,
    metadata: {},
  };
}

describe('Swarm task persistence (issue #1329)', () => {
  let backend: ReturnType<typeof createInMemoryPersistence>;

  beforeEach(() => {
    backend = createInMemoryPersistence();
    _setSwarmPersistenceForTest(new SwarmPersistence(backend.fns));
  });

  afterEach(async () => {
    _setSwarmPersistenceForTest(null);
    await _resetSwarmCoordinatorForTest();
  });

  describe('write-through', () => {
    it('writes a submitted task into the swarm-tasks namespace', async () => {
      const created = await createTask('persist me');
      expect(created.success).toBe(true);

      await waitForTaskRows(backend, 1);
      const rows = taskRows(backend);
      expect(rows.length).toBe(1);
      expect(rows[0].key).toBe(`task:${created.taskId}`);

      const parsed = JSON.parse(rows[0].content);
      expect(parsed.id.id).toBe(created.taskId);
      expect(parsed.description).toBe('persist me');
      // Dates render ISO — a raw Date would round-trip to `{}` through JSON.
      expect(typeof parsed.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(parsed.createdAt))).toBe(false);
    });

    it('leaves agent persistence behaviour untouched', async () => {
      const agentId = await spawnAgentForTest({ agentType: 'coder' });
      await createTask('alongside an agent');
      await waitForTaskRows(backend, 1);

      const agentRows = Array.from(backend.rows.values()).filter(
        r => r.namespace === SWARM_AGENTS_NS,
      );
      expect(agentRows.length).toBe(1);
      expect(agentRows[0].key).toBe(`agent:${agentId}`);
    });
  });

  describe('debounce', () => {
    it('collapses a submit burst to one write per task', async () => {
      // Each submit mutates the task twice — `created`, then `assigned` or
      // `queued`. Per-mutation writes would be 6; the debounce makes it 3.
      await createTask('burst-1');
      await createTask('burst-2');
      await createTask('burst-3');
      await waitForTaskRows(backend, 3);

      const taskWrites = backend.writes.filter(w => w.namespace === SWARM_TASKS_NS);
      expect(taskWrites.length).toBe(3);
    });

    it('does not rewrite a task whose state has not changed', async () => {
      await createTask('unchanged');
      await waitForTaskRows(backend, 1);
      const before = backend.writes.filter(w => w.namespace === SWARM_TASKS_NS).length;

      // A second task's flush walks the whole live set; the first task is
      // unchanged and must not produce a redundant upsert.
      await createTask('the other one');
      await waitForTaskRows(backend, 2);

      const after = backend.writes.filter(w => w.namespace === SWARM_TASKS_NS).length;
      expect(after - before).toBe(1);
    });
  });

  describe('restart hydration', () => {
    it('resolves task_status for a task submitted before the restart', async () => {
      const created = await createTask('survives the restart');
      await waitForTaskRows(backend, 1);

      // Singleton reset is the test analogue of an MCP-server restart.
      await _resetSwarmCoordinatorForTest();

      const status = (await getTaskTool('task_status').handler({
        taskId: created.taskId,
      })) as TaskShape;
      expect(status.status).not.toBe('not_found');
      expect(status.taskId).toBe(created.taskId);
      expect(status.description).toBe('survives the restart');
    });

    it('keeps a completed task result across the restart', async () => {
      await spawnAgentForTest({ agentType: 'coder' });
      const created = await createTask('completes before restart');
      const completed = (await getTaskTool('task_complete').handler({
        taskId: created.taskId,
        result: { answer: 42 },
      })) as { success: boolean };
      expect(completed.success).toBe(true);
      await waitForTaskRows(backend, 1);

      await _resetSwarmCoordinatorForTest();

      const status = (await getTaskTool('task_status').handler({
        taskId: created.taskId,
      })) as TaskShape;
      expect(status.status).toBe('completed');
      expect(status.result).toEqual({ answer: 42 });
    });

    it('re-links agent.currentTask for a restored non-terminal assignment', async () => {
      const agentId = await spawnAgentForTest({ agentType: 'coder' });
      const created = await createTask('assigned before restart');
      expect(created.assignedTo).toEqual([agentId]);
      await waitForTaskRows(backend, 1);

      await _resetSwarmCoordinatorForTest();

      const status = (await getAgentTool('agent_status').handler({ agentId })) as {
        currentTask?: string | null;
      };
      // Without the re-link, agent_status would report no current task while
      // task_status names this agent as the assignee.
      expect(status.currentTask).toBe(created.taskId);
    });

    it('counts restored tasks in swarm_status', async () => {
      await createTask('counted-1');
      await createTask('counted-2');
      await waitForTaskRows(backend, 2);

      await _resetSwarmCoordinatorForTest();

      const coordinator = await getSwarmCoordinator();
      expect(coordinator.getAllTasks().length).toBe(2);
    });

    it('drops a corrupt task row instead of failing the hydrate', async () => {
      const good = await createTask('intact');
      await waitForTaskRows(backend, 1);

      backend.rows.set(`${SWARM_TASKS_NS}::task:corrupt`, {
        key: 'task:corrupt',
        namespace: SWARM_TASKS_NS,
        content: '{ not json',
      });
      backend.rows.set(`${SWARM_TASKS_NS}::task:undated`, {
        key: 'task:undated',
        namespace: SWARM_TASKS_NS,
        content: JSON.stringify({ id: { id: 'task:undated' }, status: 'queued', createdAt: 'nope' }),
      });

      await _resetSwarmCoordinatorForTest();

      const coordinator = await getSwarmCoordinator();
      const ids = coordinator.getAllTasks().map(t => t.id.id);
      expect(ids).toEqual([good.taskId]);
    });

    it('does not resend task_assign messages for restored tasks', async () => {
      await spawnAgentForTest({ agentType: 'coder' });
      const created = await createTask('no replay');
      await waitForTaskRows(backend, 1);

      await _resetSwarmCoordinatorForTest();
      const coordinator = await getSwarmCoordinator();

      const seen: string[] = [];
      coordinator.on('task.assigned', () => seen.push('assigned'));
      // Give any stray replay a chance to fire before asserting.
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(seen).toEqual([]);
      expect(coordinator.getTask(created.taskId)?.status).toBe('assigned');
    });
  });

  describe('terminal-task retention', () => {
    it('trims terminal tasks beyond the cap and deletes the surplus rows', async () => {
      const persistence = new SwarmPersistence(backend.fns);
      const total = MAX_PERSISTED_TERMINAL_TASKS + 20;
      for (let i = 0; i < total; i++) {
        await persistence.persistTask(
          terminalTask(i, 'completed', new Date(1_700_000_000_000 + i * 1000)),
        );
      }
      expect(taskRows(backend).length).toBe(total);

      const loaded = await persistence.loadTasks();

      expect(loaded.length).toBe(MAX_PERSISTED_TERMINAL_TASKS);
      expect(taskRows(backend).length).toBe(MAX_PERSISTED_TERMINAL_TASKS);
      // Newest survive: the 20 oldest (indices 0-19) are the ones dropped.
      const keptIds = loaded.map(t => t.id.id).sort();
      expect(keptIds).not.toContain('task_fixture_0');
      expect(keptIds).toContain(`task_fixture_${total - 1}`);
    });

    it('never trims non-terminal tasks, however many there are', async () => {
      const persistence = new SwarmPersistence(backend.fns);
      const total = MAX_PERSISTED_TERMINAL_TASKS + 20;
      for (let i = 0; i < total; i++) {
        const task = terminalTask(i, 'queued', new Date(1_700_000_000_000 + i * 1000));
        await persistence.persistTask({ ...task, completedAt: undefined });
      }

      const loaded = await persistence.loadTasks();

      expect(loaded.length).toBe(total);
      expect(taskRows(backend).length).toBe(total);
    });

    it('classifies every task status as terminal or live exactly once', () => {
      const statuses: TaskStatus[] = [
        'created', 'queued', 'assigned', 'running', 'paused',
        'completed', 'failed', 'cancelled', 'timeout',
      ];
      const terminal = statuses.filter(isTerminalTaskStatus);
      expect(terminal).toEqual(['completed', 'failed', 'cancelled', 'timeout']);
    });
  });

  it('runs cleanly when no persistence backend is wired', async () => {
    _setSwarmPersistenceForTest(null);
    await _resetSwarmCoordinatorForTest();

    const coordinator = await getSwarmCoordinator();
    const taskId = await coordinator.submitTask({
      type: 'coding',
      name: 'no-backend',
      description: 'no backend attached',
      priority: 'normal',
      dependencies: [],
      input: null,
      timeoutMs: 1000,
      retries: 0,
      maxRetries: 3,
      metadata: {},
    });
    expect(coordinator.getTask(taskId)).toBeDefined();
    expect(taskRows(backend).length).toBe(0);
  });
});
