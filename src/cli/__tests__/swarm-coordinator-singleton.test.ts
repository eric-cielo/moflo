/**
 * Tests for the lazy swarm coordinator singleton (#799 / epic #798).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../mcp-tools/swarm-coordinator-singleton.js';

describe('swarm-coordinator-singleton', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('returns the same instance across sequential calls', async () => {
    const a = await getSwarmCoordinator();
    const b = await getSwarmCoordinator();
    expect(a).toBe(b);
  });

  it('returns a coordinator that has been initialized', async () => {
    const coord = await getSwarmCoordinator();
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
    await _resetSwarmCoordinatorForTest();
    const second = await getSwarmCoordinator();
    expect(second).not.toBe(first);
  });

  it('throws when config is passed after initialization', async () => {
    await getSwarmCoordinator();
    await expect(getSwarmCoordinator({ topology: { type: 'mesh', maxAgents: 5 } } as never))
      .rejects.toThrow(/config is honored only on the first call/);
  });
});
