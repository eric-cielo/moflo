/**
 * `swarm_init` wired to the live UnifiedSwarmCoordinator (story #803).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getSwarmTool } from './_helpers.js';

interface InitResult {
  success: boolean;
  swarmId?: string;
  topology?: string;
  topologyResolved?: string;
  initializedAt?: string;
  configApplied?: boolean;
  config?: {
    topology: string;
    maxAgents: number;
    consensusMechanism: string;
    consensusAlgorithm: string;
    consensusThreshold: number;
  };
  error?: string;
}

const SWARM_ID_RE = /^swarm_\d+_[a-z0-9]+$/;

async function init(input: Record<string, unknown> = {}): Promise<InitResult> {
  return (await getSwarmTool('swarm_init').handler(input)) as InitResult;
}

describe('swarm_init — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('returns a real swarmId from the coordinator (no Date.now stub)', async () => {
    const result = await init({ topology: 'mesh' });
    expect(result.success).toBe(true);
    expect(result.swarmId).toMatch(SWARM_ID_RE);

    const coord = await getSwarmCoordinator();
    expect(coord.getState().id.id).toBe(result.swarmId);
  });

  it('maps `unanimous` consensus to byzantine 1.0', async () => {
    const result = await init({ config: { consensusMechanism: 'unanimous' } });
    expect(result.success).toBe(true);
    expect(result.config?.consensusAlgorithm).toBe('byzantine');
    expect(result.config?.consensusThreshold).toBe(1.0);

    const coord = await getSwarmCoordinator();
    expect(coord.getConsensusAlgorithm()).toBe('byzantine');
  });

  it('maps `weighted` consensus to raft 0.66', async () => {
    const result = await init({ config: { consensusMechanism: 'weighted' } });
    expect(result.success).toBe(true);
    expect(result.config?.consensusAlgorithm).toBe('raft');
    expect(result.config?.consensusThreshold).toBeCloseTo(0.66, 5);

    const coord = await getSwarmCoordinator();
    expect(coord.getConsensusAlgorithm()).toBe('raft');
  });

  it('maps `majority` consensus to gossip 0.5', async () => {
    const result = await init({ config: { consensusMechanism: 'majority' } });
    expect(result.success).toBe(true);
    expect(result.config?.consensusAlgorithm).toBe('gossip');
    expect(result.config?.consensusThreshold).toBe(0.5);

    const coord = await getSwarmCoordinator();
    expect(coord.getConsensusAlgorithm()).toBe('gossip');
  });

  it('maps topology aliases to a valid TopologyType', async () => {
    const cases: Array<[string, string]> = [
      ['hierarchical', 'hierarchical'],
      ['mesh', 'mesh'],
      ['collective', 'mesh'],
      ['adaptive', 'hybrid'],
      ['hierarchical-mesh', 'hybrid'],
    ];

    for (const [input, expected] of cases) {
      await _resetSwarmCoordinatorForTest();
      const result = await init({ topology: input });
      expect(result.success).toBe(true);
      expect(result.topologyResolved).toBe(expected);
    }
  });

  it('rejects an unknown topology alias without throwing', async () => {
    const result = await init({ topology: 'nonsense-topology' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/topology/);
  });

  it('is idempotent — second call returns the same swarmId', async () => {
    const first = await init({ topology: 'mesh', config: { consensusMechanism: 'majority' } });
    const second = await init({ topology: 'hierarchical', config: { consensusMechanism: 'unanimous' } });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.swarmId).toBe(first.swarmId);
    // Second call's config should be flagged as not applied — singleton already
    // initialized.
    expect(second.configApplied).toBe(false);
  });
});
