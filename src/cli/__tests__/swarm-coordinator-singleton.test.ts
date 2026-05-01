/**
 * Tests for the lazy swarm coordinator singleton (Story #799 / epic #798).
 *
 * Validates:
 * - First call constructs and initializes a coordinator instance
 * - Subsequent calls return the same instance (memoization)
 * - Concurrent callers race-safe — share one in-flight init
 * - `_resetSwarmCoordinatorForTest()` clears state for the next test
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../mcp-tools/swarm-coordinator-singleton.js';

describe('swarm-coordinator-singleton', () => {
  afterEach(() => {
    _resetSwarmCoordinatorForTest();
  });

  it('returns the same instance across sequential calls', async () => {
    const a = await getSwarmCoordinator();
    const b = await getSwarmCoordinator();
    expect(a).toBe(b);
  });

  it('returns a coordinator that has been initialized', async () => {
    const coord = await getSwarmCoordinator();
    // After initialize() the coordinator should respond to its public API.
    expect(typeof coord.shutdown).toBe('function');
    expect(typeof coord.getStatus).toBe('function');
  });

  it('shares one in-flight init across concurrent callers', async () => {
    const [a, b, c] = await Promise.all([
      getSwarmCoordinator(),
      getSwarmCoordinator(),
      getSwarmCoordinator(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reset hook produces a fresh instance on the next call', async () => {
    const first = await getSwarmCoordinator();
    _resetSwarmCoordinatorForTest();
    const second = await getSwarmCoordinator();
    expect(second).not.toBe(first);
  });
});
