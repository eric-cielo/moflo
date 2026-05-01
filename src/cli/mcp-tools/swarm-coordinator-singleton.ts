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
import { SwarmPersistence, type SwarmMemoryFns } from '../swarm/swarm-persistence.js';

let _coordinator: UnifiedSwarmCoordinator | null = null;
let _initPromise: Promise<UnifiedSwarmCoordinator> | null = null;

/**
 * Test-only override for the persistence backend. When set, replaces the
 * memory-initializer-backed persistence on the next coordinator boot. Lets
 * tests inject an in-memory fake without touching sql.js or process.cwd.
 */
let _persistenceOverride: SwarmPersistence | null = null;

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

    // Story #806 — write-through persistence + restart hydration.
    // attachPersistence() and the hydrate are best-effort: a missing memory
    // backend logs nothing and leaves the coordinator running in-memory only.
    const persistence = _persistenceOverride ?? (await loadPersistence());
    if (persistence) {
      coord.attachPersistence(persistence);
      try {
        await coord.hydrateFromPersistence();
      } catch {
        // Hydration failures must not block coordinator boot — restart-recovery
        // is opportunistic durability, not a hard precondition.
      }
    }

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
 * Test-only persistence override. Pass `null` to clear. Must be called before
 * the next `getSwarmCoordinator()` to take effect on that boot.
 */
export function _setSwarmPersistenceForTest(p: SwarmPersistence | null): void {
  _persistenceOverride = p;
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

async function loadPersistence(): Promise<SwarmPersistence | undefined> {
  // Tests opt in via `_setSwarmPersistenceForTest`. Auto-loading the
  // memory-initializer in test contexts pulls in sql.js + the dogfood DB and
  // adds multi-second boot latency to every singleton-using test. Skip it.
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return undefined;
  }

  try {
    const mem = await import('../memory/memory-initializer.js');
    const fns: SwarmMemoryFns = {
      storeEntry: mem.storeEntry as SwarmMemoryFns['storeEntry'],
      getEntry: mem.getEntry as SwarmMemoryFns['getEntry'],
      listEntries: mem.listEntries as SwarmMemoryFns['listEntries'],
      deleteEntry: mem.deleteEntry as SwarmMemoryFns['deleteEntry'],
    };
    return new SwarmPersistence(fns);
  } catch {
    // Memory backend not available in this process — skip persistence rather
    // than crash. Mirrors hive-mind-tools' write-through fallback.
    return undefined;
  }
}
