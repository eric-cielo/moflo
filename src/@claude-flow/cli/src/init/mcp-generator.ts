/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 *
 * Uses direct `node` invocation when moflo is locally installed to avoid
 * npx overhead (package resolution, registry checks). Falls back to `npx`
 * for external packages (ruv-swarm, flow-nexus) that may not be installed.
 */

import { existsSync } from 'fs';
import { resolve, join } from 'path';
import type { InitOptions, MCPConfig } from './types.js';

/**
 * Generate MCP server entry using npx (for external packages)
 */
function createNpxServerEntry(
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
 * Generate MCP server entry using direct node invocation (for local moflo).
 * Avoids npx overhead — faster startup, fewer intermediate processes.
 */
function createDirectServerEntry(
  cliPath: string,
  cliArgs: string[],
  env: Record<string, string>,
  additionalProps: Record<string, unknown> = {}
): object {
  return {
    command: 'node',
    args: [cliPath, ...cliArgs],
    env,
    ...additionalProps,
  };
}

/**
 * Find the moflo CLI entry point relative to the project root.
 * Returns the path if found, null otherwise.
 */
function findMofloCli(projectRoot: string): string | null {
  const candidates = [
    // Installed as dependency
    join(projectRoot, 'node_modules', 'moflo', 'bin', 'cli.js'),
    // Running from moflo repo itself
    join(projectRoot, 'bin', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

  const mcpEnv = {
    ...npmEnv,
    CLAUDE_FLOW_MODE: 'v3',
    CLAUDE_FLOW_HOOKS_ENABLED: 'true',
    CLAUDE_FLOW_TOPOLOGY: options.runtime.topology,
    CLAUDE_FLOW_MAX_AGENTS: String(options.runtime.maxAgents),
    CLAUDE_FLOW_MEMORY_BACKEND: options.runtime.memoryBackend,
  };

  // Claude Flow MCP server (core) — use direct node when locally installed
  if (config.claudeFlow) {
    const projectRoot = options.targetDir ?? process.cwd();
    const localCli = findMofloCli(projectRoot);

    if (localCli) {
      mcpServers['claude-flow'] = createDirectServerEntry(
        localCli,
        ['mcp', 'start'],
        mcpEnv,
        { autoStart: config.autoStart, ...deferProps }
      );
    } else {
      mcpServers['claude-flow'] = createNpxServerEntry(
        ['moflo', 'mcp', 'start'],
        mcpEnv,
        { autoStart: config.autoStart, ...deferProps }
      );
    }
  }

  // Ruv-Swarm MCP server (enhanced coordination) — always npx (external package)
  if (config.ruvSwarm) {
    mcpServers['ruv-swarm'] = createNpxServerEntry(
      ['ruv-swarm', 'mcp', 'start'],
      { ...npmEnv },
      { optional: true, ...deferProps }
    );
  }

  // Flow Nexus MCP server (cloud features) — always npx (external package)
  if (config.flowNexus) {
    mcpServers['flow-nexus'] = createNpxServerEntry(
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
    const projectRoot = options.targetDir ?? process.cwd();
    const localCli = findMofloCli(projectRoot);
    if (localCli) {
      commands.push(`claude mcp add claude-flow -- node ${localCli} mcp start`);
    } else {
      commands.push('claude mcp add claude-flow -- npx -y moflo mcp start');
    }
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
