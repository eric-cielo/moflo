/**
 * Issue #825: hive-mind_spawn / hive-mind_shutdown must write the legacy
 * agents.json store under findProjectRoot()/.moflo, NOT under process.cwd().
 *
 * Mirrors agent-tools.ts (which already uses findProjectRoot via getAgentDir).
 * Without this, an MCP server launched from a subdirectory writes the hive
 * store outside the consumer's project — silently disagreeing with the
 * agent_spawn-side store at <project-root>/.moflo/agents/store.json.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let fakeProjectRoot = '';
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => fakeProjectRoot,
}));

import { hiveMindTools } from '../../mcp-tools/hive-mind-tools.js';
import { _resetSwarmCoordinatorForTest } from '../../mcp-tools/swarm-coordinator-singleton.js';

const initTool = hiveMindTools.find(t => t.name === 'hive-mind_init')!;
const spawnTool = hiveMindTools.find(t => t.name === 'hive-mind_spawn')!;
const shutdownTool = hiveMindTools.find(t => t.name === 'hive-mind_shutdown')!;

describe('hive-mind agent store path (issue #825)', () => {
  let originalCwd: string;
  let cwdSentinel: string;

  beforeEach(() => {
    fakeProjectRoot = mkdtempSync(join(tmpdir(), 'moflo-hive-store-root-'));
    writeFileSync(join(fakeProjectRoot, 'package.json'), '{"name":"fake"}');
    cwdSentinel = mkdtempSync(join(tmpdir(), 'moflo-hive-store-cwd-'));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await _resetSwarmCoordinatorForTest();
    rmSync(fakeProjectRoot, { recursive: true, force: true });
    rmSync(cwdSentinel, { recursive: true, force: true });
    fakeProjectRoot = '';
  });

  it('writes agents.json under findProjectRoot()/.moflo on spawn', async () => {
    await initTool.handler({ topology: 'mesh' });
    const result = (await spawnTool.handler({ count: 1, agentType: 'worker' })) as {
      success: boolean;
      workers?: Array<{ agentId: string }>;
    };
    expect(result.success).toBe(true);
    expect(result.workers?.length).toBe(1);

    const expectedPath = resolve(fakeProjectRoot, '.moflo', 'agents.json');
    expect(existsSync(expectedPath)).toBe(true);

    const stored = JSON.parse(readFileSync(expectedPath, 'utf-8')) as {
      agents: Record<string, unknown>;
    };
    expect(stored.agents[result.workers![0].agentId]).toBeDefined();

    await shutdownTool.handler({ force: true });
  });

  it('does not write under process.cwd() when cwd diverges from project root', async () => {
    process.chdir(cwdSentinel);

    await initTool.handler({ topology: 'mesh' });
    const result = (await spawnTool.handler({ count: 1, agentType: 'worker' })) as {
      success: boolean;
    };
    expect(result.success).toBe(true);

    // The bug would have created agents.json under cwd. With the fix in
    // place, this must not exist.
    const buggyPath = resolve(cwdSentinel, '.moflo', 'agents.json');
    expect(existsSync(buggyPath)).toBe(false);

    // And the correct project-root-anchored path must exist.
    const correctPath = resolve(fakeProjectRoot, '.moflo', 'agents.json');
    expect(existsSync(correctPath)).toBe(true);

    await shutdownTool.handler({ force: true });
  });

  it('reads existing store from findProjectRoot()/.moflo on shutdown', async () => {
    // Pre-seed the project-root-anchored store with a worker, then verify
    // shutdown reads it from there (loadAgentStore path) and clears it.
    const dotMoflo = resolve(fakeProjectRoot, '.moflo');
    mkdirSync(dotMoflo, { recursive: true });
    const storePath = join(dotMoflo, 'agents.json');

    await initTool.handler({ topology: 'mesh' });
    const spawn = (await spawnTool.handler({ count: 2, agentType: 'worker' })) as {
      success: boolean;
      workers?: Array<{ agentId: string }>;
    };
    expect(spawn.success).toBe(true);

    const after = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(after.agents).length).toBe(2);

    await shutdownTool.handler({ force: true });

    // shutdown's loadAgentStore + saveAgentStore should have removed the
    // workers via the same project-root path.
    const cleared = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(cleared.agents).length).toBe(0);
  });
});
