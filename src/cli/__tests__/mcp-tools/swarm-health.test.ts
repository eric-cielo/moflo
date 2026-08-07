/**
 * `swarm_health` wired to the live UnifiedSwarmCoordinator (story #803).
 *
 * #1422 — these tests pin `CLAUDE_PROJECT_DIR` at an anchor that owns a
 * `.moflo/` directory. The `memory` check is an existence probe on
 * `findProjectRoot() + .moflo`, and `findProjectRoot` honours
 * `CLAUDE_PROJECT_DIR` ahead of any filesystem walk. Without the pin, the
 * baseline assertion below reads through to whatever anchor the ambient
 * environment happens to name: every vitest fork runs many files in one
 * process, ~25 of them set `CLAUDE_PROJECT_DIR` to a throwaway tmp dir, and
 * `vitest.setup.ts` restores `process.cwd()` between files but not this
 * variable. Any of them leaking leaves a *correct* `swarm_health` reporting
 * `degraded` here for a reason that has nothing to do with the swarm.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { getSwarmTool, spawnAgentForTest } from './_helpers.js';

interface HealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  swarmId: string;
  checks: Array<{ name: string; status: 'ok' | 'fail'; message: string }>;
  checkedAt: string;
}

async function callInit(input: Record<string, unknown> = {}) {
  return getSwarmTool('swarm_init').handler(input);
}

async function callHealth(input: Record<string, unknown> = {}): Promise<HealthResult> {
  return (await getSwarmTool('swarm_health').handler(input)) as HealthResult;
}

/** `name: message` for every failing check — so a red run names the culprit. */
function failures(result: HealthResult): string {
  const failed = result.checks.filter(c => c.status === 'fail');
  return failed.length === 0
    ? '(no failing checks)'
    : failed.map(c => `${c.name}: ${c.message}`).join('; ');
}

describe('swarm_health — coordinator-backed', () => {
  let originalProjectDir: string | undefined;
  let anchorDir: string;

  beforeEach(() => {
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    // realpathSync: macOS hands out `/var/folders/...` paths that resolve to
    // `/private/var/folders/...`, and findProjectRoot canonicalizes (#1145).
    anchorDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1422-health-')));
    mkdirSync(join(anchorDir, '.moflo'), { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = anchorDir;
  });

  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    rmSync(anchorDir, { recursive: true, force: true });
  });

  it('returns healthy with all 4 checks ok on a fresh swarm', async () => {
    await callInit();
    const result = await callHealth();

    // The message matters more than the assertion here: pre-#1422 this failed
    // as a bare `expected 'degraded' to be 'healthy'`, which named neither the
    // failing check nor the anchor it resolved against.
    expect(result.status, `failing checks — ${failures(result)}`).toBe('healthy');
    expect(result.checks).toHaveLength(4);
    const names = result.checks.map(c => c.name).sort();
    expect(names).toEqual(['agents', 'coordinator', 'memory', 'messaging']);
    expect(result.checks.every(c => c.status === 'ok')).toBe(true);
  });

  it('is not perturbed by an ambient project root that has no .moflo dir', async () => {
    // The exact condition that produced the #1422 report. `swarm_health` is
    // right to call this degraded — a project with no `.moflo/` really has no
    // memory backend — so the guarantee under test is that the *anchor* is
    // pinned by the block above and an inherited value cannot reach it.
    const strayRoot = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1422-stray-')));
    try {
      await callInit();
      const pinned = await callHealth();
      expect(pinned.status, `failing checks — ${failures(pinned)}`).toBe('healthy');

      // Point the resolver at a root with no `.moflo/` and the memory check
      // must fail — proving the pin above is what is doing the work, not that
      // the probe stopped looking.
      process.env.CLAUDE_PROJECT_DIR = strayRoot;
      const strayed = await callHealth();
      expect(strayed.status).toBe('degraded');
      expect(strayed.checks.find(c => c.name === 'memory')?.status).toBe('fail');

      process.env.CLAUDE_PROJECT_DIR = anchorDir;
      expect((await callHealth()).status).toBe('healthy');
    } finally {
      rmSync(strayRoot, { recursive: true, force: true });
    }
  });

  it('flips to degraded when an agent has low health', async () => {
    await callInit();
    const agentId = await spawnAgentForTest({ agentType: 'coder' });

    // Mutate agent health below the 0.7 threshold to simulate a degraded agent.
    const coord = await getSwarmCoordinator();
    const agent = coord.getAgent(agentId);
    expect(agent).toBeDefined();
    agent!.health = 0.1;

    const result = await callHealth();
    expect(result.status).toBe('degraded');
    const agentsCheck = result.checks.find(c => c.name === 'agents');
    expect(agentsCheck?.status).toBe('fail');
    expect(agentsCheck?.message).toMatch(/degraded/);

    // Coordinator itself is still running, so other checks remain ok.
    const coordinatorCheck = result.checks.find(c => c.name === 'coordinator');
    expect(coordinatorCheck?.status).toBe('ok');
  });

  it('reports unhealthy when the coordinator is shut down', async () => {
    await callInit();
    const coord = await getSwarmCoordinator();
    await coord.shutdown();

    const result = await callHealth();
    expect(result.status).toBe('unhealthy');
    const coordinatorCheck = result.checks.find(c => c.name === 'coordinator');
    expect(coordinatorCheck?.status).toBe('fail');
    expect(coordinatorCheck?.message).toMatch(/stopped/);
  });

  it('passes swarmId through when caller supplies one', async () => {
    await callInit();
    const result = await callHealth({ swarmId: 'caller-supplied-id' });
    expect(result.swarmId).toBe('caller-supplied-id');
  });
});
