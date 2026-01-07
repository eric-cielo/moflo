/**
 * V3 CLI Commands Index
 * Central registry for all CLI commands
 */

import type { Command } from '../types.js';
import { agentCommand } from './agent.js';
import { swarmCommand } from './swarm.js';
import { memoryCommand } from './memory.js';
import { mcpCommand } from './mcp.js';
import { configCommand } from './config.js';
import { migrateCommand } from './migrate.js';
import { hooksCommand } from './hooks.js';
import { workflowCommand } from './workflow.js';
import { hiveMindCommand } from './hive-mind.js';
import { processCommand } from './process.js';
// P1 Commands
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { statusCommand } from './status.js';
import { taskCommand } from './task.js';
import { sessionCommand } from './session.js';
import { daemonCommand } from './daemon.js';
// V3 Advanced Commands
import { neuralCommand } from './neural.js';
import { securityCommand } from './security.js';
import { performanceCommand } from './performance.js';
import { providersCommand } from './providers.js';
import { pluginsCommand } from './plugins.js';
import { deploymentCommand } from './deployment.js';
import { claimsCommand } from './claims.js';
import { embeddingsCommand } from './embeddings.js';
// P0 Commands
import { completionsCommand } from './completions.js';
import { doctorCommand } from './doctor.js';
// Analysis Commands
import { analyzeCommand } from './analyze.js';
// Q-Learning Routing Commands
import { routeCommand } from './route.js';

// Export all commands
export { agentCommand } from './agent.js';
export { swarmCommand } from './swarm.js';
export { memoryCommand } from './memory.js';
export { mcpCommand } from './mcp.js';
export { configCommand } from './config.js';
export { migrateCommand } from './migrate.js';
export { hooksCommand } from './hooks.js';
export { workflowCommand } from './workflow.js';
export { hiveMindCommand } from './hive-mind.js';
export { processCommand } from './process.js';
// P1 Commands
export { initCommand } from './init.js';
export { startCommand } from './start.js';
export { statusCommand } from './status.js';
export { taskCommand } from './task.js';
export { sessionCommand } from './session.js';
export { daemonCommand } from './daemon.js';
// V3 Advanced Commands
export { neuralCommand } from './neural.js';
export { securityCommand } from './security.js';
export { performanceCommand } from './performance.js';
export { providersCommand } from './providers.js';
export { pluginsCommand } from './plugins.js';
export { deploymentCommand } from './deployment.js';
export { claimsCommand } from './claims.js';
export { embeddingsCommand } from './embeddings.js';
// P0 Commands
export { completionsCommand } from './completions.js';
export { doctorCommand } from './doctor.js';
// Analysis Commands
export { analyzeCommand } from './analyze.js';
// Q-Learning Routing Commands
export { routeCommand } from './route.js';

/**
 * All available commands
 */
export const commands: Command[] = [
  // P1 Core Commands
  initCommand,
  startCommand,
  statusCommand,
  taskCommand,
  sessionCommand,
  // Original Commands
  agentCommand,
  swarmCommand,
  memoryCommand,
  mcpCommand,
  configCommand,
  migrateCommand,
  hooksCommand,
  workflowCommand,
  hiveMindCommand,
  processCommand,
  daemonCommand,
  // V3 Advanced Commands
  neuralCommand,
  securityCommand,
  performanceCommand,
  providersCommand,
  pluginsCommand,
  deploymentCommand,
  claimsCommand,
  embeddingsCommand,
  // P0 Commands
  completionsCommand,
  doctorCommand,
  // Analysis Commands
  analyzeCommand,
];

/**
 * Command registry map for quick lookup
 */
export const commandRegistry = new Map<string, Command>();

// Register all commands and their aliases
for (const cmd of commands) {
  commandRegistry.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandRegistry.set(alias, cmd);
    }
  }
}

/**
 * Get command by name
 */
export function getCommand(name: string): Command | undefined {
  return commandRegistry.get(name);
}

/**
 * Check if command exists
 */
export function hasCommand(name: string): boolean {
  return commandRegistry.has(name);
}

/**
 * Get all command names (including aliases)
 */
export function getCommandNames(): string[] {
  return Array.from(commandRegistry.keys());
}

/**
 * Get all unique commands (excluding aliases)
 */
export function getUniqueCommands(): Command[] {
  return commands.filter(cmd => !cmd.hidden);
}

/**
 * Setup commands in a CLI instance
 */
export function setupCommands(cli: { command: (cmd: Command) => void }): void {
  for (const cmd of commands) {
    cli.command(cmd);
  }
}
