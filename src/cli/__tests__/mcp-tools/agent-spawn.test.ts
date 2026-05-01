/**
 * `agent_spawn` wired to the live UnifiedSwarmCoordinator (story #801).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { agentTools } from '../../mcp-tools/agent-tools.js';
import {
  _resetSwarmCoordinatorForTest,
  getSwarmCoordinator,
} from '../../mcp-tools/swarm-coordinator-singleton.js';
import { SUBAGENT_BOOTSTRAP_DIRECTIVE } from '../../services/subagent-bootstrap.js';

const ID_RE = /^agent-[a-z][a-z0-9-]*-[0-9a-f]{24}$/;

interface SpawnResult {
  success: boolean;
  agentId?: string;
  agentType?: string;
  domain?: string;
  status?: string;
  spawned?: boolean;
  model?: string;
  modelRoutedBy?: string;
  bootstrap?: string;
  error?: string;
}

async function spawn(input: Record<string, unknown>): Promise<SpawnResult> {
  const tool = agentTools.find(t => t.name === 'agent_spawn');
  if (!tool) throw new Error('agent_spawn tool missing from agentTools');
  return (await tool.handler(input)) as SpawnResult;
}

describe('agent_spawn — coordinator-backed', () => {
  afterEach(async () => {
    await _resetSwarmCoordinatorForTest();
  });

  it('spawns a live agent reachable via coordinator.getAgent', async () => {
    const result = await spawn({ agentType: 'coder' });

    expect(result.success).toBe(true);
    expect(result.agentId).toBeDefined();
    expect(result.agentId!).toMatch(ID_RE);

    const coord = await getSwarmCoordinator();
    const live = coord.getAgent(result.agentId!);
    expect(live).toBeDefined();
    expect(live!.type).toBe('coder');
    expect(live!.status).toBe('idle');
  });

  it('embeds the canonical bootstrap directive byte-for-byte', async () => {
    const result = await spawn({ agentType: 'researcher' });
    expect(result.bootstrap).toBe(SUBAGENT_BOOTSTRAP_DIRECTIVE);
  });

  it('rejects unknown agent types without throwing', async () => {
    const result = await spawn({ agentType: 'definitely-not-a-real-type' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/whitelist|allowed/i);
  });

  it('rejects non-string agent types without throwing', async () => {
    const result = await spawn({ agentType: 123 as unknown as string });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects malformed slugs (uppercase / punctuation)', async () => {
    for (const bad of ['Coder', 'coder!', 'a b', '../traversal']) {
      const result = await spawn({ agentType: bad });
      expect(result.success).toBe(false);
    }
  });

  it('honors explicit model selection (modelRoutedBy=explicit)', async () => {
    const result = await spawn({ agentType: 'coder', model: 'opus' });
    expect(result.success).toBe(true);
    expect(result.model).toBe('opus');
    expect(result.modelRoutedBy).toBe('explicit');
  });

  it('falls back to AGENT_TYPE_MODEL_DEFAULTS when no model/task supplied', async () => {
    const result = await spawn({ agentType: 'architect' });
    expect(result.success).toBe(true);
    expect(result.model).toBe('opus');
    expect(result.modelRoutedBy).toBe('default');
  });

  it('passes domain through to the coordinator', async () => {
    const result = await spawn({ agentType: 'tester', domain: 'support' });
    expect(result.success).toBe(true);
    expect(result.domain).toBe('support');
  });

  it('generates collision-resistant ids across burst spawns', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const result = await spawn({ agentType: 'worker' });
      expect(result.success).toBe(true);
      ids.add(result.agentId!);
    }
    expect(ids.size).toBe(25);
  });
});
