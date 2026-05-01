/**
 * Contract: hive-mind_spawn / hive-mind_shutdown route through the swarm
 * coordinator only — no parallel JSON file-store.
 *
 *   - spawn registers workers with the coordinator under the 'hive-mind' domain
 *   - shutdown terminates them via the coordinator
 *   - neither handler writes .moflo/agents.json
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeProjectRoot = '';
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => fakeProjectRoot,
}));

import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getHiveMindTool } from './_helpers.js';

const initTool = getHiveMindTool('hive-mind_init');
const spawnTool = getHiveMindTool('hive-mind_spawn');
const shutdownTool = getHiveMindTool('hive-mind_shutdown');

describe('hive-mind coordinator state', () => {
  beforeEach(() => {
    fakeProjectRoot = mkdtempSync(join(tmpdir(), 'moflo-hive-833-'));
    writeFileSync(join(fakeProjectRoot, 'package.json'), '{"name":"fake"}');
  });

  afterEach(async () => {
    await shutdownTool.handler({ force: true }).catch(() => undefined);
    await _resetSwarmCoordinatorForTest();
    rmSync(fakeProjectRoot, { recursive: true, force: true });
    fakeProjectRoot = '';
  });

  it('spawn registers workers with the coordinator in the hive-mind domain', async () => {
    await initTool.handler({ topology: 'mesh' });
    const result = (await spawnTool.handler({ count: 2, agentType: 'worker' })) as {
      success: boolean;
      workers?: Array<{ agentId: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.workers?.length).toBe(2);

    const coordinator = await getSwarmCoordinator();
    const hiveAgents = coordinator.listAgents({ domain: 'hive-mind' });
    expect(hiveAgents.length).toBe(2);
    const ids = new Set(hiveAgents.map(a => a.agentId));
    for (const w of result.workers!) {
      expect(ids.has(w.agentId)).toBe(true);
    }
  });

  it('shutdown terminates workers via the coordinator', async () => {
    await initTool.handler({ topology: 'mesh' });
    const spawn = (await spawnTool.handler({ count: 2, agentType: 'worker' })) as {
      success: boolean;
    };
    expect(spawn.success).toBe(true);

    const coordinator = await getSwarmCoordinator();
    expect(coordinator.listAgents({ domain: 'hive-mind' }).length).toBe(2);

    const result = (await shutdownTool.handler({ force: true })) as {
      success: boolean;
      workersTerminated: number;
    };
    expect(result.success).toBe(true);
    expect(result.workersTerminated).toBe(2);

    expect(coordinator.listAgents({ domain: 'hive-mind' }).length).toBe(0);
  });

  it('does not write .moflo/agents.json on spawn or shutdown', async () => {
    const legacyPath = join(fakeProjectRoot, '.moflo', 'agents.json');

    await initTool.handler({ topology: 'mesh' });
    await spawnTool.handler({ count: 2, agentType: 'worker' });
    expect(existsSync(legacyPath)).toBe(false);

    await shutdownTool.handler({ force: true });
    expect(existsSync(legacyPath)).toBe(false);
  });
});
