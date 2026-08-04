/**
 * A health probe must not accumulate state (#1370).
 *
 * `flo doctor`'s swarm check spawns a real agent and submits a real task to
 * prove the coordinator path is wired (the #798 tripwire). Both were persisted:
 * #1329 made task state durable, and agent rows have been durable since #806.
 * Nothing removed them, so every doctor run grew the store — and once 15 agent
 * rows had piled up, the coordinator's cap rejected the probe spawn and the
 * check failed on every subsequent run. A health check that breaks itself by
 * being used is worse than no health check.
 *
 * The fix is "never write it", not "write then delete it". Persistence writes
 * resolve on hand-off to the daemon rather than on commit, so a delete issued
 * after a spawn/submit cannot be ordered against it — verified the hard way:
 * a delete-after-write version still left rows behind on every run.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createUnifiedSwarmCoordinator } from '../../swarm/unified-coordinator.js';
import type { SwarmPersistence } from '../../swarm/swarm-persistence.js';

/** Records what the coordinator asked the store to do. */
function recordingPersistence() {
  const persistedTasks: string[] = [];
  const persistedAgents: string[] = [];
  const removedAgents: string[] = [];
  return {
    calls: { persistedTasks, persistedAgents, removedAgents },
    fake: {
      persistTask: async (task: { id: { id: string } }) => { persistedTasks.push(task.id.id); },
      persistAgent: async (agent: { id: { id: string } }) => { persistedAgents.push(agent.id.id); },
      removeAgent: async (agentId: string) => { removedAgents.push(agentId); },
      loadTasks: async () => [],
      loadAgents: async () => [],
      loadTopology: async () => undefined,
      persistTopology: async () => {},
      loadConsensusHistory: async () => [],
      persistConsensus: async () => {},
    } as unknown as SwarmPersistence,
  };
}

/** Let the microtask-scheduled persist flush run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 10));

let coordinator: ReturnType<typeof createUnifiedSwarmCoordinator>;
let store: ReturnType<typeof recordingPersistence>;

beforeEach(async () => {
  coordinator = createUnifiedSwarmCoordinator();
  await coordinator.initialize();
  store = recordingPersistence();
  coordinator.attachPersistence(store.fake);
});

describe('ephemeral tasks are never written to the store', () => {
  it('persists an ordinary task', async () => {
    const id = await coordinator.submitTask({
      type: 'coding', name: 't', description: 'real work',
      priority: 'normal', dependencies: [], input: null,
      timeoutMs: 1000, retries: 0, maxRetries: 1, metadata: {},
    });
    await settle();
    expect(store.calls.persistedTasks).toContain(id);
  });

  it('does not persist one marked ephemeral', async () => {
    const id = await coordinator.submitTask({
      type: 'coding', name: 't', description: 'doctor-functional-probe',
      priority: 'normal', dependencies: [], input: null,
      timeoutMs: 1000, retries: 0, maxRetries: 1,
      metadata: { ephemeral: true },
    });
    await settle();
    expect(store.calls.persistedTasks).not.toContain(id);
  });

  it('stays out of the store across its whole lifecycle, not just at submit', async () => {
    // The leak was a row left mid-lifecycle: submit wrote it, and the completion
    // that would have made it terminal never landed. Every transition must be
    // silent, or the row reappears in exactly the state the retention trim
    // refuses to reclaim.
    const id = await coordinator.submitTask({
      type: 'coding', name: 't', description: 'doctor-functional-probe',
      priority: 'normal', dependencies: [], input: null,
      timeoutMs: 1000, retries: 0, maxRetries: 1,
      metadata: { ephemeral: true },
    });
    await coordinator.completeTask(id, { ok: true });
    await settle();
    expect(store.calls.persistedTasks).toEqual([]);
  });
});

describe('ephemeral agents are never written to the store', () => {
  it('persists an ordinary agent', async () => {
    const { agentId } = await coordinator.spawnAgent({ id: 'agent-real-1', type: 'coder' });
    await settle();
    expect(store.calls.persistedAgents).toContain(agentId);
  });

  it('does not persist one spawned with ephemeral metadata', async () => {
    const { agentId } = await coordinator.spawnAgent({
      id: 'agent-probe-1', type: 'coder', metadata: { ephemeral: true },
    });
    await settle();
    expect(store.calls.persistedAgents).not.toContain(agentId);
  });

  it('leaves nothing behind over spawn → terminate, the doctor probe cycle', async () => {
    const { agentId } = await coordinator.spawnAgent({
      id: 'agent-probe-2', type: 'coder', metadata: { ephemeral: true },
    });
    await coordinator.terminateAgent(agentId, { force: true, reason: 'test' });
    await settle();
    expect(store.calls.persistedAgents).toEqual([]);
  });

  it('repeated probe cycles never grow the store — the cap failure', async () => {
    // 20 cycles is past the 15-agent cap that took the check down.
    for (let i = 0; i < 20; i++) {
      const { agentId } = await coordinator.spawnAgent({
        id: `agent-probe-loop-${i}`, type: 'coder', metadata: { ephemeral: true },
      });
      const taskId = await coordinator.submitTask({
        type: 'coding', name: 't', description: 'doctor-functional-probe',
        priority: 'normal', dependencies: [], input: null,
        timeoutMs: 1000, retries: 0, maxRetries: 1,
        metadata: { ephemeral: true },
      });
      await coordinator.completeTask(taskId, { ok: true });
      await coordinator.terminateAgent(agentId, { force: true, reason: 'test' });
      await settle();
    }
    expect(store.calls.persistedAgents).toEqual([]);
    expect(store.calls.persistedTasks).toEqual([]);
  });
});
