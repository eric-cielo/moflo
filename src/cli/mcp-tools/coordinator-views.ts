/**
 * Shared coordinator-state views for MCP tool handlers.
 *
 * Centralizes the "live agents" and "utilization" projections so handlers
 * across `agent-tools.ts`, `swarm-scale-handler.ts`, etc. share one
 * definition rather than re-implementing the terminated-agent filter.
 */

import type { AgentState } from '../swarm/types.js';
import type { UnifiedSwarmCoordinator } from '../swarm/unified-coordinator.js';

export function liveAgents(coordinator: UnifiedSwarmCoordinator): AgentState[] {
  return coordinator.getAllAgents().filter(a => a.status !== 'terminated');
}

export function utilizationOf(coordinator: UnifiedSwarmCoordinator): number {
  let total = 0;
  let busy = 0;
  for (const agent of coordinator.getAllAgents()) {
    if (agent.status === 'terminated') continue;
    total++;
    if (agent.status === 'busy') busy++;
  }
  return total === 0 ? 0 : busy / total;
}
