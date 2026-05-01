/**
 * Lazy singleton for UnifiedSwarmCoordinator.
 *
 * Init cost (~tens of ms — TopologyManager + MessageBus + ConsensusEngine + AgentPools)
 * is only paid on the first swarm/agent/task tool call, not on memory-search-only sessions.
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
 * `config` is honored only on the very first call. Passing config after the
 * coordinator is already initialized is a misuse — it would silently be
 * ignored, so we throw to surface it.
 */
export async function getSwarmCoordinator(
  config?: Partial<CoordinatorConfig>,
): Promise<UnifiedSwarmCoordinator> {
  if (_coordinator) {
    if (config !== undefined) {
      throw new Error(
        'getSwarmCoordinator(config) called after initialization — config is honored only on the first call. Reset via _resetSwarmCoordinatorForTest() if you need to re-initialize.',
      );
    }
    return _coordinator;
  }
  if (_initPromise) return _initPromise;

  // In-flight promise cache so concurrent callers share a single bootstrap
  // rather than racing two coordinator constructions.
  _initPromise = (async () => {
    const coord = createUnifiedSwarmCoordinator(config);
    await coord.initialize();
    _coordinator = coord;
    return coord;
  })();

  try {
    return await _initPromise;
  } finally {
    // Always clear so a failed init lets the next call retry.
    _initPromise = null;
  }
}

/**
 * Whether a coordinator has already been bootstrapped in this process.
 * Lets callers (e.g. `swarm_init`) decide whether to pass config or treat
 * the call as idempotent without abusing the singleton's misuse-throw.
 */
export function isSwarmCoordinatorInitialized(): boolean {
  return _coordinator !== null;
}

/**
 * Test-only reset hook. Awaits shutdown so timers and listeners are torn down
 * before the next test's coordinator boots — fire-and-forget would leak
 * intervals across the suite.
 */
export async function _resetSwarmCoordinatorForTest(): Promise<void> {
  const coord = _coordinator;
  _coordinator = null;
  _initPromise = null;
  if (coord) {
    try {
      await coord.shutdown();
    } catch {
      // Swallow: test teardown should not fail because shutdown raced.
    }
  }
}
