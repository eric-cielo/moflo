/**
 * Shared helpers for mcp-tools tests.
 */

import { agentTools } from '../../mcp-tools/agent-tools.js';
import { hiveMindTools } from '../../mcp-tools/hive-mind-tools.js';
import { swarmTools } from '../../mcp-tools/swarm-tools.js';
import { taskTools } from '../../mcp-tools/task-tools.js';
import type { MCPTool } from '../../mcp-tools/types.js';

export function getAgentTool(name: string): MCPTool {
  const tool = agentTools.find(t => t.name === name);
  if (!tool) throw new Error(`agent tool "${name}" not registered`);
  return tool;
}

export function getSwarmTool(name: string): MCPTool {
  const tool = swarmTools.find(t => t.name === name);
  if (!tool) throw new Error(`swarm tool "${name}" not registered`);
  return tool;
}

export function getTaskTool(name: string): MCPTool {
  const tool = taskTools.find(t => t.name === name);
  if (!tool) throw new Error(`task tool "${name}" not registered`);
  return tool;
}

export function getHiveMindTool(name: string): MCPTool {
  const tool = hiveMindTools.find(t => t.name === name);
  if (!tool) throw new Error(`hive-mind tool "${name}" not registered`);
  return tool;
}

export async function spawnAgentForTest(
  input: Record<string, unknown> = { agentType: 'coder' },
): Promise<string> {
  const result = (await getAgentTool('agent_spawn').handler(input)) as {
    success: boolean;
    agentId?: string;
    error?: string;
  };
  if (!result.success || !result.agentId) {
    throw new Error(`spawnAgentForTest failed: ${result.error ?? 'unknown'}`);
  }
  return result.agentId;
}
