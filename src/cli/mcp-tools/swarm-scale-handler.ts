/**
 * `swarm_scale` MCP tool handler — strategy-aware scaling routed through
 * UnifiedSwarmCoordinator (epic #798, story #804). The MCPTool registration
 * lives in `./swarm-tools.ts` so the drift-guard regex (#693) sees the
 * `name: 'swarm_scale'` literal in the file `mcp-client.ts` imports.
 *
 * Three strategies:
 *   - `immediate`: sequential awaits with no inter-op delay
 *   - `gradual`:   sequential awaits with 200ms between operations
 *   - `adaptive`:  chunked, where chunk size shrinks under coordinator load
 *
 * On scale-up failure the partial fleet is rolled back so callers don't end
 * up owning agents they didn't ask for.
 */

import { randomBytes } from 'node:crypto';
import { getSwarmCoordinator } from './swarm-coordinator-singleton.js';
import { validateAgentType } from './agent-tools.js';
import { liveAgents, utilizationOf } from './coordinator-views.js';
import type { AgentState, AgentType } from '../swarm/types.js';

export type ScaleStrategy = 'gradual' | 'immediate' | 'adaptive';

export const SCALE_STRATEGIES: readonly ScaleStrategy[] = ['gradual', 'immediate', 'adaptive'];

export const TARGET_AGENTS_MIN = 1;
export const TARGET_AGENTS_MAX = 1000;

// Ticket #804: gradual strategy is "1 agent per 200ms".
const GRADUAL_INTERVAL_MS = 200;

// Adaptive chunking: spawns/terminates per chunk when coordinator is light vs busy.
// Utilization = busy / live agents. < 0.5 → light load → larger chunks.
const ADAPTIVE_CHUNK_LIGHT = 10;
const ADAPTIVE_CHUNK_BUSY = 3;
const ADAPTIVE_INTERCHUNK_MS = 50;
const ADAPTIVE_LIGHT_THRESHOLD = 0.5;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const isScaleStrategy = (value: unknown): value is ScaleStrategy =>
  typeof value === 'string' && (SCALE_STRATEGIES as readonly string[]).includes(value);

function pickAgentType(agentTypes: string[] | undefined, index: number): string {
  if (!agentTypes || agentTypes.length === 0) return 'worker';
  return agentTypes[index % agentTypes.length];
}

function selectAgentsToTerminate(
  candidates: AgentState[],
  count: number,
  agentTypes: string[] | undefined,
): AgentState[] {
  let pool = candidates;
  if (agentTypes && agentTypes.length > 0) {
    const set = new Set(agentTypes);
    pool = pool.filter(a => set.has(a.type));
  }
  // Idle first (cheap to terminate — no grace period). Within a status bucket,
  // oldest heartbeat first so we drain dormant agents before fresh ones.
  const sorted = [...pool].sort((a, b) => {
    if (a.status === 'idle' && b.status !== 'idle') return -1;
    if (b.status === 'idle' && a.status !== 'idle') return 1;
    return a.lastHeartbeat.getTime() - b.lastHeartbeat.getTime();
  });
  return sorted.slice(0, count);
}

async function executeWithStrategy(
  strategy: ScaleStrategy,
  count: number,
  utilizationProvider: () => number,
  fn: (index: number) => Promise<void>,
): Promise<void> {
  if (strategy === 'immediate') {
    for (let i = 0; i < count; i++) await fn(i);
    return;
  }

  if (strategy === 'gradual') {
    for (let i = 0; i < count; i++) {
      await fn(i);
      if (i < count - 1) await sleep(GRADUAL_INTERVAL_MS);
    }
    return;
  }

  // adaptive: chunk size adapts to coordinator load between chunks.
  let i = 0;
  while (i < count) {
    const utilization = utilizationProvider();
    const chunk = utilization < ADAPTIVE_LIGHT_THRESHOLD ? ADAPTIVE_CHUNK_LIGHT : ADAPTIVE_CHUNK_BUSY;
    const end = Math.min(i + chunk, count);
    for (let j = i; j < end; j++) await fn(j);
    i = end;
    if (i < count) await sleep(ADAPTIVE_INTERCHUNK_MS);
  }
}

interface ScaleResult {
  swarmId: string;
  previousAgents: number;
  targetAgents: number;
  currentAgents: number;
  scalingStatus: 'completed' | 'in-progress' | 'failed';
  scaleStrategy: ScaleStrategy;
  scaledAt: string;
  addedAgents?: string[];
  removedAgents?: string[];
  reason?: string;
  error?: string;
}

interface FailureContext {
  scaledAt: string;
  scaleStrategy: ScaleStrategy;
  reason?: string;
}

function failure(error: string, ctx: FailureContext, partial?: Partial<ScaleResult>): ScaleResult {
  return {
    swarmId: '',
    previousAgents: 0,
    targetAgents: 0,
    currentAgents: 0,
    scalingStatus: 'failed',
    scaleStrategy: ctx.scaleStrategy,
    scaledAt: ctx.scaledAt,
    reason: ctx.reason,
    error,
    ...partial,
  };
}

export async function scaleHandler(input: Record<string, unknown>): Promise<ScaleResult> {
  const scaledAt = new Date().toISOString();
  const reason = input.reason as string | undefined;

  const strategyInput = input.scaleStrategy ?? 'gradual';
  if (!isScaleStrategy(strategyInput)) {
    return failure(
      `scaleStrategy "${String(strategyInput)}" must be one of ${SCALE_STRATEGIES.join(', ')}`,
      { scaledAt, scaleStrategy: 'gradual', reason },
    );
  }
  const strategy: ScaleStrategy = strategyInput;

  const ctx: FailureContext = { scaledAt, scaleStrategy: strategy, reason };

  const targetRaw = input.targetAgents;
  const targetAgents = typeof targetRaw === 'number' ? targetRaw : Number(targetRaw);
  if (
    !Number.isFinite(targetAgents) ||
    !Number.isInteger(targetAgents) ||
    targetAgents < TARGET_AGENTS_MIN ||
    targetAgents > TARGET_AGENTS_MAX
  ) {
    return failure(
      `targetAgents must be an integer between ${TARGET_AGENTS_MIN} and ${TARGET_AGENTS_MAX}`,
      ctx,
      { targetAgents: Number.isFinite(targetAgents) ? targetAgents : 0 },
    );
  }

  const agentTypesRaw = input.agentTypes;
  let agentTypes: string[] | undefined;
  if (agentTypesRaw !== undefined) {
    if (!Array.isArray(agentTypesRaw)) {
      return failure('agentTypes must be an array of strings', ctx, { targetAgents });
    }
    const validated: string[] = [];
    for (const t of agentTypesRaw) {
      const v = validateAgentType(t);
      if (!v.ok) {
        return failure(`agentTypes: ${v.error}`, ctx, { targetAgents });
      }
      validated.push(t as string);
    }
    agentTypes = validated;
  }

  const coordinator = await getSwarmCoordinator();
  const swarmId = coordinator.getState().id.id;
  const liveBefore = liveAgents(coordinator);
  const previousAgents = liveBefore.length;
  const delta = targetAgents - previousAgents;

  if (delta === 0) {
    return {
      swarmId,
      previousAgents,
      targetAgents,
      currentAgents: previousAgents,
      scalingStatus: 'completed',
      scaleStrategy: strategy,
      scaledAt,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  const addedAgents: string[] = [];
  const removedAgents: string[] = [];
  let opError: Error | undefined;

  const utilizationProvider = (): number => utilizationOf(coordinator);

  try {
    if (delta > 0) {
      await executeWithStrategy(strategy, delta, utilizationProvider, async (i) => {
        const agentType = pickAgentType(agentTypes, i);
        const agentId = `agent-scaled-${agentType}-${randomBytes(6).toString('hex')}`;
        const spawned = await coordinator.spawnAgent({
          id: agentId,
          type: agentType as AgentType,
          metadata: { scaledAt, scaleStrategy: strategy, scaleIndex: i, scaleReason: reason },
        });
        addedAgents.push(spawned.agentId);
      });
    } else {
      const targetsToTerminate = selectAgentsToTerminate(liveBefore, -delta, agentTypes);
      await executeWithStrategy(strategy, targetsToTerminate.length, utilizationProvider, async (i) => {
        const target = targetsToTerminate[i];
        const result = await coordinator.terminateAgent(target.id.id, { reason: reason ?? 'swarm_scale' });
        if (result.terminated) removedAgents.push(result.agentId);
      });
    }
  } catch (err) {
    opError = err as Error;
  }

  // Roll back partial scale-up on failure: agents we just spawned are owners
  // we silently leaked otherwise. Splice out so the result-shape spread below
  // omits them — the contract is "rolled-back agents are reported as if they
  // never existed", which matches scalingStatus: 'failed'.
  if (opError && delta > 0 && addedAgents.length > 0) {
    const toRollback = addedAgents.splice(0);
    for (const id of toRollback) {
      try {
        await coordinator.terminateAgent(id, { reason: 'swarm_scale rollback', force: true });
      } catch {
        // Best-effort — surfacing the original error is more useful than
        // a noisier composite.
      }
    }
  }

  const currentAgents = liveAgents(coordinator).length;
  const scalingStatus: ScaleResult['scalingStatus'] = opError
    ? 'failed'
    : currentAgents === targetAgents
      ? 'completed'
      : 'in-progress';

  return {
    swarmId,
    previousAgents,
    targetAgents,
    currentAgents,
    scalingStatus,
    scaleStrategy: strategy,
    scaledAt,
    ...(addedAgents.length > 0 ? { addedAgents } : {}),
    ...(removedAgents.length > 0 ? { removedAgents } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(opError ? { error: opError.message } : {}),
  };
}
