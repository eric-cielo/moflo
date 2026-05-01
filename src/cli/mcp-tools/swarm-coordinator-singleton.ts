/**
 * Swarm Coordinator Singleton — lazy module-level instance for MCP tool handlers
 *
 * Story #799 (epic #798): MCP tool handlers (`agent_*`, `swarm_*`, `task_*`) need a
 * shared `UnifiedSwarmCoordinator` to dispatch real lifecycle operations against.
 * Mirrors the hive-mind-tools.ts:24-70 pattern (lazy MessageBus singleton).
 *
 * Why lazy: coordinator init spins up TopologyManager + MessageBus + ConsensusEngine
 * + AgentPools (~tens of ms). If a session only calls memory_search, it should not
 * pay that cost. First swarm/agent/task tool call triggers init; subsequent calls
 * reuse the cached instance.
 *
 * Race-safety: an in-flight init promise is cached so concurrent callers share a
 * single bootstrap rather than racing two coordinator constructions.
 */

import {
  UnifiedSwarmCoordinator,
  createUnifiedSwarmCoordinator,
} from '../swarm/unified-coordinator.js';
import type { CoordinatorConfig } from '../swarm/types.js';

let _coordinator: UnifiedSwarmCoordinator | null = null;
let _initPromise: Promise<UnifiedSwarmCoordinator> | null = null;

/**
 * Get the singleton swarm coordinator, lazy-initializing on first call.
 *
 * Concurrent callers receive the same in-flight initialization promise so that
 * exactly one coordinator is constructed regardless of how many handlers race.
 */
export async function getSwarmCoordinator(
  config?: Partial<CoordinatorConfig>,
): Promise<UnifiedSwarmCoordinator> {
  if (_coordinator) return _coordinator;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const coord = createUnifiedSwarmCoordinator(config);
    await coord.initialize();
    _coordinator = coord;
    return coord;
  })();

  try {
    return await _initPromise;
  } finally {
    // Clear the promise cache only once the result is settled. If init fails,
    // the next call should be allowed to retry rather than re-await a failed promise.
    if (!_coordinator) {
      _initPromise = null;
    }
  }
}

/**
 * Test-only reset hook. Resets the singleton state so each test gets a fresh
 * coordinator. Not exported from `index.ts`; only callable from test files
 * that import this module directly.
 */
export function _resetSwarmCoordinatorForTest(): void {
  if (_coordinator) {
    // Best-effort shutdown so tests don't leak background timers.
    try {
      void _coordinator.shutdown();
    } catch {
      // Swallow — test is tearing down anyway.
    }
  }
  _coordinator = null;
  _initPromise = null;
}
