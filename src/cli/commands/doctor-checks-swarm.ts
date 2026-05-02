/**
 * Functional Doctor Checks for Swarm + Hive-Mind (issue #818, epic #798)
 *
 * Exercises the real UnifiedSwarmCoordinator + MessageBus + WriteThroughAdapter
 * paths through the MCP tool surface. Regression tripwire for the
 * silent-disconnect failure that triggered #798: handlers returning hardcoded
 * literals (e.g. `{ swarmId: 'swarm-' + Date.now() }`,
 * `{ agentCount: 0, taskCount: 0 }`) while the install otherwise looks healthy.
 *
 * Path resolution mirrors `doctor-checks-deep.ts` — modules load from the
 * moflo package root via `import.meta.url`, so checks behave identically in
 * the dev tree and in `node_modules/moflo/...` consumer installs.
 */

import {
  type FunctionalCheckDetail,
  type FunctionalHealthCheck,
  type ToolHandler,
  loadToolArrays,
  getTool,
  safeInvoke,
  summarizeFunctional,
} from './doctor-checks-functional-shared.js';

// Re-exported for callers that imported these from doctor-checks-swarm.ts
// (tests, other doctor checks) before the shared module was extracted.
export type { FunctionalCheckDetail, FunctionalHealthCheck };

const SWARM_FUNCTIONAL_CHECK = 'Swarm Functional';
const HIVE_FUNCTIONAL_CHECK = 'Hive-Mind Functional';
const SWARM_FAIL_FIX = 'Run `flo doctor --json` for per-subcheck details; investigate any handler that disconnected from UnifiedSwarmCoordinator (epic #798)';

/**
 * Stub-sentinel pattern for the #798 regression:
 * `swarmId: 'swarm-' + Date.now()` (hyphen + ms only). The live coordinator
 * uses underscore separators with a random suffix
 * (`swarm_${Date.now()}_${random}`); seeing a value matching the sentinel
 * shape means the handler is disconnected from `UnifiedSwarmCoordinator`.
 */
const STUB_SWARM_ID_PATTERN = /^swarm-\d+$/;

function summarize(name: string, details: FunctionalCheckDetail[]): FunctionalHealthCheck {
  return summarizeFunctional(name, details, {
    passSuffix: '(coordinator path verified)',
    failFix: SWARM_FAIL_FIX,
  });
}

// ============================================================================
// Swarm Functional Check
// ============================================================================

export async function checkSwarmFunctional(): Promise<FunctionalHealthCheck> {
  const details: FunctionalCheckDetail[] = [];

  const mods = await loadToolArrays({
    swarmTools: 'dist/src/cli/mcp-tools/swarm-tools.js',
    agentTools: 'dist/src/cli/mcp-tools/agent-tools.js',
    taskTools: 'dist/src/cli/mcp-tools/task-tools.js',
  });
  if (!mods) {
    return { name: SWARM_FUNCTIONAL_CHECK, status: 'warn', message: 'swarm/agent/task tool modules not built', fix: 'npm run build' };
  }
  const { swarmTools, agentTools, taskTools } = mods;

  // 1. swarm_init returns a coordinator-issued id, not the stub literal.
  // Real id format is `swarm_${Date.now()}_${random}` (underscore); regression
  // literal was `swarm-${Date.now()}` (hyphen).
  await safeInvoke(swarmTools, 'swarm_init', { topology: 'mesh' }, details, {
    id: 'swarm_init.coordinator-issued-id',
    mcpTool: 'swarm_init',
    expected: 'success=true with a non-stub swarmId from UnifiedSwarmCoordinator',
    assert: (raw) => {
      const out = raw as { success?: boolean; swarmId?: string };
      if (!out?.success) return 'handler returned success=false';
      if (typeof out.swarmId !== 'string' || !out.swarmId) return 'no swarmId returned';
      if (STUB_SWARM_ID_PATTERN.test(out.swarmId)) {
        return 'swarmId matches stub literal `swarm-${Date.now()}` shape — handler may be disconnected from coordinator';
      }
      return null;
    },
  });

  // 2. agent_spawn registers an agent on the live coordinator.
  const spawnOut = (await safeInvoke(agentTools, 'agent_spawn', { agentType: 'coder' }, details, {
    id: 'agent_spawn.coordinator-backed',
    mcpTool: 'agent_spawn',
    expected: 'success=true with an agentId issued by coordinator.spawnAgent (not a JSON-store write)',
    assert: (raw) => {
      const out = raw as { success?: boolean; agentId?: string; spawned?: boolean };
      if (!out?.success) return `success=false: ${JSON.stringify(out)}`;
      if (typeof out.agentId !== 'string' || !out.agentId) return 'no agentId returned';
      if (out.spawned !== true) return 'spawned!=true — coordinator may not have accepted the spawn';
      return null;
    },
  })) as { agentId?: string } | undefined;
  const agentId = spawnOut?.agentId;

  // 3. agent_list reflects coordinator state, not the legacy file-store.
  if (agentId) {
    await safeInvoke(agentTools, 'agent_list', {}, details, {
      id: 'agent_list.coordinator-state',
      mcpTool: 'agent_list',
      expected: `agent_list contains the just-spawned ${agentId} (proves coordinator-backed read, not JSON-store stub)`,
      assert: (raw) => {
        const agents = (raw as { agents?: Array<{ agentId: string }> })?.agents ?? [];
        if (!Array.isArray(agents) || agents.length === 0) {
          return 'agent_list returned 0 agents after agent_spawn — handler may be reading the legacy JSON store';
        }
        if (!agents.some(a => a.agentId === agentId)) {
          return `spawned agent ${agentId} not in agent_list (got: ${agents.map(a => a.agentId).join(', ')})`;
        }
        return null;
      },
    });

    // 4. agent_status returns coordinator-tracked status (idle | busy).
    await safeInvoke(agentTools, 'agent_status', { agentId, includeMetrics: false }, details, {
      id: 'agent_status.coordinator-state',
      mcpTool: 'agent_status',
      expected: 'agent_status returns coordinator-tracked status (idle | busy)',
      assert: (raw) => {
        const out = raw as { status?: string; agentId?: string };
        if (!out?.status) return 'no status field in response';
        if (!['idle', 'busy'].includes(out.status)) return `expected idle|busy, got "${out.status}"`;
        if (out.agentId !== agentId) return `expected agentId=${agentId}, got ${out.agentId}`;
        return null;
      },
    });
  }

  // 5. swarm_status agentCount/taskCount are live (regression returned hardcoded 0).
  await safeInvoke(swarmTools, 'swarm_status', {}, details, {
    id: 'swarm_status.live-counts',
    mcpTool: 'swarm_status',
    expected: 'agentCount > 0 and taskCount is a live coordinator counter',
    assert: (raw) => {
      const out = raw as { agentCount?: number; taskCount?: number; agentSummary?: { total?: number } };
      if (typeof out?.agentCount !== 'number') return 'agentCount missing';
      if (out.agentCount === 0) {
        return 'agentCount=0 after agent_spawn — handler likely returns hardcoded `{ agentCount: 0, taskCount: 0 }` literal';
      }
      if (typeof out.taskCount !== 'number') return 'taskCount missing';
      if (out.agentSummary?.total !== out.agentCount) {
        return `agentSummary.total (${out.agentSummary?.total}) != agentCount (${out.agentCount})`;
      }
      return null;
    },
  });

  // 6. swarm_health surfaces the coordinator probe.
  await safeInvoke(swarmTools, 'swarm_health', {}, details, {
    id: 'swarm_health.coordinator-probe',
    mcpTool: 'swarm_health',
    expected: 'checks[] includes a `coordinator` entry sourced from coordinator.getState()',
    assert: (raw) => {
      const out = raw as { checks?: Array<{ name: string }>; status?: string };
      const checks = Array.isArray(out?.checks) ? out.checks : null;
      if (!checks) return 'no checks[] in response — handler likely stubbed';
      if (!checks.some(c => c.name === 'coordinator')) return `no coordinator check (got: ${checks.map(c => c.name).join(', ')})`;
      if (typeof out.status !== 'string') return 'no overall status field';
      return null;
    },
  });

  // 7. task_create round-trips through coordinator.submitTask.
  const taskOut = (await safeInvoke(taskTools, 'task_create', {
    type: 'coding', description: 'doctor-functional-probe',
  }, details, {
    id: 'task_create.coordinator-submit',
    mcpTool: 'task_create',
    expected: 'success=true with a coordinator-issued taskId',
    assert: (raw) => {
      const out = raw as { success?: boolean; taskId?: string };
      if (!out?.success) return `task_create returned ${JSON.stringify(out)}`;
      if (typeof out.taskId !== 'string' || !out.taskId) return 'no taskId in response';
      return null;
    },
  })) as { taskId?: string } | undefined;
  const taskId = taskOut?.taskId;

  // 8. task_complete advances state through coordinator.completeTask.
  if (taskId) {
    await safeInvoke(taskTools, 'task_complete', { taskId, result: { ok: true } }, details, {
      id: 'task_complete.coordinator-state',
      mcpTool: 'task_complete',
      expected: 'success=true and status=completed via coordinator.completeTask',
      assert: (raw) => {
        const out = raw as { success?: boolean; status?: string };
        if (!out?.success) return `task_complete returned ${JSON.stringify(out)}`;
        if (out.status !== 'completed') return `expected status=completed, got "${out.status}"`;
        return null;
      },
    });
  }

  // 9. agent_terminate flows through coordinator.terminateAgent (also cleanup).
  if (agentId) {
    await safeInvoke(agentTools, 'agent_terminate', { agentId, force: true, reason: 'doctor-cleanup' }, details, {
      id: 'agent_terminate.coordinator-removes',
      mcpTool: 'agent_terminate',
      expected: 'success=true and terminated=true; agent removed from coordinator state',
      assert: (raw) => {
        const out = raw as { success?: boolean; terminated?: boolean };
        if (!out?.success) return `agent_terminate returned ${JSON.stringify(out)}`;
        if (out.terminated !== true) return `expected terminated=true, got ${out.terminated}`;
        return null;
      },
    });
  }

  return summarize(SWARM_FUNCTIONAL_CHECK, details);
}

// ============================================================================
// Hive-Mind Functional Check
// ============================================================================

export async function checkHiveMindFunctional(): Promise<FunctionalHealthCheck> {
  const details: FunctionalCheckDetail[] = [];

  const mods = await loadToolArrays({
    hiveMindTools: 'dist/src/cli/mcp-tools/hive-mind-tools.js',
    agentTools: 'dist/src/cli/mcp-tools/agent-tools.js',
  });
  if (!mods) {
    return { name: HIVE_FUNCTIONAL_CHECK, status: 'warn', message: 'hive-mind / agent tool modules not built', fix: 'npm run build' };
  }
  const { hiveMindTools, agentTools } = mods;

  // 1. hive-mind_init wires MessageBus + WriteThroughAdapter (story #121).
  await safeInvoke(hiveMindTools, 'hive-mind_init', { topology: 'mesh' }, details, {
    id: 'hive-mind_init.bus-and-adapter',
    mcpTool: 'hive-mind_init',
    expected: 'success=true with hiveId and status=initialized',
    assert: (raw) => {
      const out = raw as { success?: boolean; hiveId?: string; status?: string };
      if (!out?.success) return 'init returned success=false';
      if (typeof out.hiveId !== 'string' || !out.hiveId) return 'no hiveId returned';
      if (out.status !== 'initialized') return `expected status=initialized, got "${out.status}"`;
      return null;
    },
  });

  // 2. hive-mind_spawn registers workers with the shared coordinator (story #807).
  const spawnOut = (await safeInvoke(hiveMindTools, 'hive-mind_spawn', {
    count: 2, role: 'worker', agentType: 'worker',
  }, details, {
    id: 'hive-mind_spawn.shared-coordinator',
    mcpTool: 'hive-mind_spawn',
    expected: 'spawned=2 with worker ids registered on the shared coordinator',
    assert: (raw) => {
      const out = raw as { success?: boolean; spawned?: number; workers?: Array<{ agentId: string }> };
      if (!out?.success) return `hive-mind_spawn returned ${JSON.stringify(out)}`;
      if (out.spawned !== 2) return `expected spawned=2, got ${out.spawned}`;
      if (!Array.isArray(out.workers) || out.workers.length !== 2) {
        return `workers[] missing or wrong length: ${JSON.stringify(out.workers)}`;
      }
      return null;
    },
  })) as { workers?: Array<{ agentId: string }> } | undefined;

  const workerIds: string[] = (spawnOut?.workers ?? [])
    .map(w => w.agentId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  // 3. swarm agent_list({domain:'hive-mind'}) sees those workers — proves shared state.
  if (workerIds.length > 0) {
    await safeInvoke(agentTools, 'agent_list', { domain: 'hive-mind' }, details, {
      id: 'agent_list.hive-domain-visible',
      mcpTool: 'agent_list',
      expected: `swarm agent_list({domain:'hive-mind'}) returns the ${workerIds.length} hive workers`,
      assert: (raw) => {
        const ids = ((raw as { agents?: Array<{ agentId: string }> })?.agents ?? []).map(a => a.agentId);
        const missing = workerIds.filter(id => !ids.includes(id));
        if (missing.length > 0) {
          return `${missing.length} hive worker(s) missing from swarm agent_list — coordinator shared-state regression (${missing.join(', ')})`;
        }
        return null;
      },
    });
  }

  // 4. hive-mind_broadcast exchanges via MessageBus.
  await safeInvoke(hiveMindTools, 'hive-mind_broadcast', {
    message: 'doctor-probe', priority: 'normal',
  }, details, {
    id: 'hive-mind_broadcast.bus-exchange',
    mcpTool: 'hive-mind_broadcast',
    expected: 'success=true with messageId and recipients matching worker count',
    assert: (raw) => {
      const out = raw as { success?: boolean; messageId?: string; recipients?: number };
      if (!out?.success) return 'broadcast returned success=false';
      if (typeof out.messageId !== 'string' || !out.messageId) return 'no messageId from MessageBus';
      if (out.recipients !== workerIds.length) return `recipients=${out.recipients} != worker count=${workerIds.length}`;
      return null;
    },
  });

  // 5. hive-mind_consensus tallies real votes.
  if (workerIds.length >= 2) {
    const propose = (await safeInvoke(hiveMindTools, 'hive-mind_consensus', {
      action: 'propose', type: 'doctor-test', value: { x: 1 }, voterId: workerIds[0],
    }, details, {
      id: 'hive-mind_consensus.propose',
      mcpTool: 'hive-mind_consensus',
      expected: 'proposalId returned with status=pending',
      assert: (raw) => {
        const out = raw as { proposalId?: string; status?: string };
        if (typeof out?.proposalId !== 'string' || !out.proposalId) return 'no proposalId';
        if (out.status !== 'pending') return `expected status=pending, got "${out.status}"`;
        return null;
      },
    })) as { proposalId?: string } | undefined;

    if (propose?.proposalId) {
      await safeInvoke(hiveMindTools, 'hive-mind_consensus', {
        action: 'vote', proposalId: propose.proposalId, vote: true, voterId: workerIds[0],
      }, details, {
        id: 'hive-mind_consensus.vote-tally',
        mcpTool: 'hive-mind_consensus',
        expected: 'votesFor>=1 after first vote (real tally, not stubbed approval)',
        assert: (raw) => {
          const out = raw as { votesFor?: number };
          if (typeof out?.votesFor !== 'number') return 'votesFor missing';
          if (out.votesFor < 1) return `expected votesFor>=1, got ${out.votesFor}`;
          return null;
        },
      });
    }
  }

  // 6. hive-mind_memory roundtrips via Memory DB write-through.
  // Memory backend unavailable (e.g. fresh smoke fixture before `memory init`)
  // is environmental, not a regression — softFailMessage downgrades to warn.
  const probeKey = `doctor-probe-${Date.now()}`;
  const sentinel = `hive-doctor-${Date.now()}`;
  const setOut = await safeInvoke(hiveMindTools, 'hive-mind_memory', {
    action: 'set', key: probeKey, value: { sentinel },
  }, details, {
    id: 'hive-mind_memory.set',
    mcpTool: 'hive-mind_memory',
    expected: 'memory set succeeds via Memory DB write-through',
    softFailMessage: (raw) => (raw as { success?: boolean })?.success === true
      ? null
      : 'memory set returned success=false — Memory DB unavailable (likely fresh consumer fixture, not a regression)',
    assert: () => null,
  });

  if ((setOut as { success?: boolean } | undefined)?.success === true) {
    await safeInvoke(hiveMindTools, 'hive-mind_memory', { action: 'get', key: probeKey }, details, {
      id: 'hive-mind_memory.get',
      mcpTool: 'hive-mind_memory',
      expected: 'memory get returns previously-set value (proves shared store, not in-memory only)',
      assert: (raw) => {
        const out = raw as { exists?: boolean; value?: { sentinel?: string } };
        if (!out?.exists) return 'get returned exists=false after a successful set — write-through to Memory DB is broken';
        if (out.value?.sentinel !== sentinel) return `value mismatch: expected sentinel="${sentinel}", got ${JSON.stringify(out.value)}`;
        return null;
      },
    });
  }

  // 7. Cleanup — graceful shutdown (best-effort; failures here aren't a regression signal).
  try {
    const shutdown = getTool(hiveMindTools, 'hive-mind_shutdown');
    if (shutdown?.handler) await shutdown.handler({ force: true });
  } catch { /* ignore */ }

  return summarize(HIVE_FUNCTIONAL_CHECK, details);
}
