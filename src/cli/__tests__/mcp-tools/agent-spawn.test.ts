/**
 * Story #801 — `agent_spawn` wired to the live UnifiedSwarmCoordinator.
 *
 * Pins:
 *   - Spawn writes through the coordinator (not the JSON store)
 *   - Returned id matches the Ruflo-style regex and is reachable via
 *     `coordinator.getAgent(id)` in the same handler call
 *   - Response.bootstrap is byte-equal to the canonical directive (#800)
 *   - Whitelist + slug validation rejects without throwing
 *   - ADR-026 model routing preserved on the coordinator path
 */

import { afterEach, describe, expect, it } from 'vitest';
import { agentTools } from '../../mcp-tools/agent-tools.js';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../../services/subagent-bootstrap.js';

const ID_RE = /^agent-[a-z][a-z0-9-]*-[0-9a-f]{24}$/;

function findSpawnTool() {
  const tool = agentTools.find(t => t.name === 'agent_spawn');
  if (!tool) throw new Error('agent_spawn tool missing from agentTools');
  return tool;
}

describe('agent_spawn — coordinator-backed (story #801)', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('spawns a live agent reachable via coordinator.getAgent', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({ agentType: 'coder' })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(typeof result.agentId).toBe('string');
    expect(result.agentId as string).toMatch(ID_RE);

    const coord = await getSwarmCoordinator();
    const live = coord.getAgent(result.agentId as string);
    expect(live).toBeDefined();
    expect(live!.type).toBe('coder');
    expect(live!.status).toBe('idle');
  });

  it('embeds the canonical bootstrap directive byte-for-byte', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({ agentType: 'researcher' })) as Record<string, unknown>;
    expect(result.bootstrap).toBe(SUBAGENT_BOOTSTRAP_DIRECTIVE);
  });

  it('rejects unknown agent types without throwing', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({ agentType: 'definitely-not-a-real-type' })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error as string).toMatch(/whitelist|allowed/i);
  });

  it('rejects non-string agent types without throwing', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({ agentType: 123 as unknown as string })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects malformed slugs (uppercase / punctuation)', async () => {
    const tool = findSpawnTool();
    for (const bad of ['Coder', 'coder!', 'a b', '../traversal']) {
      const result = (await tool.handler({ agentType: bad })) as Record<string, unknown>;
      expect(result.success).toBe(false);
    }
  });

  it('honors explicit model selection (modelRoutedBy=explicit)', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({
      agentType: 'coder',
      model: 'opus',
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.model).toBe('opus');
    expect(result.modelRoutedBy).toBe('explicit');
  });

  it('falls back to AGENT_TYPE_MODEL_DEFAULTS when no model/task supplied', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({ agentType: 'architect' })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.model).toBe('opus');
    expect(result.modelRoutedBy).toBe('default');
  });

  it('passes domain through to the coordinator', async () => {
    const tool = findSpawnTool();
    const result = (await tool.handler({
      agentType: 'tester',
      domain: 'support',
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.domain).toBe('support');
  });

  it('generates collision-resistant ids across burst spawns', async () => {
    const tool = findSpawnTool();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const result = (await tool.handler({ agentType: 'worker' })) as Record<string, unknown>;
      expect(result.success).toBe(true);
      ids.add(result.agentId as string);
    }
    expect(ids.size).toBe(25);
  });
});
