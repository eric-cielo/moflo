/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 *
 * Note: Claude Code spawns MCP servers as child processes using the
 * command/args from .mcp.json. On all platforms (including Windows),
 * using `npx` directly works correctly. The previous `cmd /c` wrapper
 * on Windows caused MCP servers to fail to start.
 */

import type { InitOptions, MCPConfig } from './types.js';

/**
 * Generate MCP server entry
 * Uses `npx` directly on all platforms — Claude Code handles process
 * spawning correctly without needing a cmd.exe wrapper.
 */
function createMCPServerEntry(
  npxArgs: string[],
  env: Record<string, string>,
  additionalProps: Record<string, unknown> = {}
): object {
  return {
    command: 'npx',
    args: ['-y', ...npxArgs],
    env,
    ...additionalProps,
  };
}

/**
 * Generate MCP configuration
 */
export function generateMCPConfig(options: InitOptions): object {
  const config = options.mcp;
  const mcpServers: Record<string, object> = {};

  const npmEnv = {
    npm_config_update_notifier: 'false',
  };

  // When toolDefer is true, emit "deferred" so Claude Code loads schemas on
  // demand via ToolSearch instead of putting 150+ schemas into context at startup.
  const deferProps = config.toolDefer ? { toolDefer: 'deferred' } : {};

  // Claude Flow MCP server (core)
  if (config.claudeFlow) {
    mcpServers['claude-flow'] = createMCPServerEntry(
      ['moflo', 'mcp', 'start'],
      {
        ...npmEnv,
        CLAUDE_FLOW_MODE: 'v3',
        CLAUDE_FLOW_HOOKS_ENABLED: 'true',
        CLAUDE_FLOW_TOPOLOGY: options.runtime.topology,
        CLAUDE_FLOW_MAX_AGENTS: String(options.runtime.maxAgents),
        CLAUDE_FLOW_MEMORY_BACKEND: options.runtime.memoryBackend,
      },
      { autoStart: config.autoStart, ...deferProps }
    );
  }

  // Ruv-Swarm MCP server (enhanced coordination)
  if (config.ruvSwarm) {
    mcpServers['ruv-swarm'] = createMCPServerEntry(
      ['ruv-swarm', 'mcp', 'start'],
      { ...npmEnv },
      { optional: true, ...deferProps }
    );
  }

  // Flow Nexus MCP server (cloud features)
  if (config.flowNexus) {
    mcpServers['flow-nexus'] = createMCPServerEntry(
      ['flow-nexus@latest', 'mcp', 'start'],
      { ...npmEnv },
      { optional: true, requiresAuth: true, ...deferProps }
    );
  }

  return { mcpServers };
}

/**
 * Generate .mcp.json as formatted string
 */
export function generateMCPJson(options: InitOptions): string {
  const config = generateMCPConfig(options);
  return JSON.stringify(config, null, 2);
}

/**
 * Generate MCP server add commands for manual setup
 */
export function generateMCPCommands(options: InitOptions): string[] {
  const commands: string[] = [];
  const config = options.mcp;

  if (config.claudeFlow) {
    commands.push('claude mcp add claude-flow -- npx -y moflo mcp start');
  }
  if (config.ruvSwarm) {
    commands.push('claude mcp add ruv-swarm -- npx -y ruv-swarm mcp start');
  }
  if (config.flowNexus) {
    commands.push('claude mcp add flow-nexus -- npx -y flow-nexus@latest mcp start');
  }

  return commands;
}

/**
 * Get platform-specific setup instructions
 */
export function getPlatformInstructions(): { platform: string; note: string } {
  const platform = process.platform === 'win32'
    ? 'Windows'
    : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    platform,
    note: 'MCP configuration uses npx directly.',
  };
}
