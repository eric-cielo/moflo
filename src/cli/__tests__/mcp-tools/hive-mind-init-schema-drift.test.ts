/**
 * Issue #826: hive-mind_init must declare every input field its handler reads,
 * and the values it accepts must actually drive hive state — no silent echoes,
 * no hardcoded lies in hive-mind_status.
 *
 * Before this fix:
 *   - inputSchema declared only { topology, queenId }
 *   - handler read input.consensus / maxAgents / persist / memoryBackend
 *   - hive-mind_status hardcoded `consensus: 'byzantine'` regardless of init
 *   - hive-mind_spawn clamped count to 20 hardcoded, ignoring maxAgents
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeProjectRoot = '';
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => fakeProjectRoot,
}));

import { hiveMindTools } from '../../mcp-tools/hive-mind-tools.js';
import { _resetSwarmCoordinatorForTest } from '../../mcp-tools/swarm-coordinator-singleton.js';

const initTool = hiveMindTools.find(t => t.name === 'hive-mind_init')!;
const statusTool = hiveMindTools.find(t => t.name === 'hive-mind_status')!;
const spawnTool = hiveMindTools.find(t => t.name === 'hive-mind_spawn')!;
const shutdownTool = hiveMindTools.find(t => t.name === 'hive-mind_shutdown')!;

interface InitResult {
  success: boolean;
  hiveId: string;
  topology: string;
  consensus: string;
  status: string;
  config: {
    topology: string;
    consensus: string;
    maxAgents: number;
    persist: boolean;
    memoryBackend: string;
  };
}

interface StatusResult {
  consensus: string;
  config: {
    consensus: string;
    maxAgents: number;
    persist: boolean;
    memoryBackend: string;
  };
}

interface SpawnResult {
  success: boolean;
  spawned: number;
  requested?: number;
  cappedByMaxAgents?: number | null;
  workers?: Array<{ agentId: string }>;
  error?: string;
}

describe('hive-mind_init — schema drift (issue #826)', () => {
  beforeEach(() => {
    fakeProjectRoot = mkdtempSync(join(tmpdir(), 'moflo-hive-826-'));
    writeFileSync(join(fakeProjectRoot, 'package.json'), '{"name":"fake"}');
  });

  afterEach(async () => {
    await shutdownTool.handler({ force: true }).catch(() => undefined);
    await _resetSwarmCoordinatorForTest();
    rmSync(fakeProjectRoot, { recursive: true, force: true });
    fakeProjectRoot = '';
  });

  it('declares every field the handler accepts (no schema/handler drift)', () => {
    const props = (initTool.inputSchema?.properties ?? {}) as Record<string, unknown>;
    for (const field of ['topology', 'queenId', 'consensus', 'maxAgents', 'persist', 'memoryBackend']) {
      expect(props[field], `inputSchema.properties.${field} missing`).toBeDefined();
    }
  });

  it('round-trips defaults when only topology is given', async () => {
    const result = (await initTool.handler({ topology: 'mesh' })) as InitResult;
    expect(result.success).toBe(true);
    expect(result.consensus).toBe('byzantine');
    expect(result.config).toMatchObject({
      consensus: 'byzantine',
      maxAgents: 15,
      persist: true,
      memoryBackend: 'hybrid',
    });
  });

  it('persists consensus into hive state — status no longer hardcodes byzantine', async () => {
    await initTool.handler({ topology: 'mesh', consensus: 'raft' });
    const status = (await statusTool.handler({})) as StatusResult;
    expect(status.consensus).toBe('raft');
    expect(status.config.consensus).toBe('raft');
  });

  it('round-trips persist:false and memoryBackend:memory through status.config', async () => {
    await initTool.handler({ topology: 'mesh', persist: false, memoryBackend: 'memory' });
    const status = (await statusTool.handler({})) as StatusResult;
    expect(status.config.persist).toBe(false);
    expect(status.config.memoryBackend).toBe('memory');
  });

  it('falls back to byzantine for unknown consensus values (no untyped passthrough)', async () => {
    const result = (await initTool.handler({ topology: 'mesh', consensus: 'nonsense' })) as InitResult;
    expect(result.consensus).toBe('byzantine');
  });

  it('hive-mind_spawn enforces maxAgents — caps a request that exceeds the cap', async () => {
    await initTool.handler({ topology: 'mesh', maxAgents: 3 });
    const result = (await spawnTool.handler({ count: 5, agentType: 'worker' })) as SpawnResult;
    expect(result.success).toBe(true);
    expect(result.spawned).toBe(3);
    expect(result.requested).toBe(5);
    expect(result.cappedByMaxAgents).toBe(3);
    expect(result.workers?.length).toBe(3);
  });

  it('hive-mind_spawn returns capacity error when hive is full', async () => {
    await initTool.handler({ topology: 'mesh', maxAgents: 1 });
    const first = (await spawnTool.handler({ count: 1, agentType: 'worker' })) as SpawnResult;
    expect(first.success).toBe(true);
    expect(first.spawned).toBe(1);

    const second = (await spawnTool.handler({ count: 1, agentType: 'worker' })) as SpawnResult;
    expect(second.success).toBe(false);
    expect(second.spawned).toBe(0);
    expect(second.error).toMatch(/capacity/i);
  });
});
