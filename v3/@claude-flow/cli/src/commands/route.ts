/**
 * V3 CLI Route Command
 * Intelligent task-to-agent routing using Q-Learning
 *
 * Features:
 * - Q-Learning based agent selection
 * - Semantic task understanding
 * - Confidence scoring
 * - Learning from feedback
 *
 * Created with love by ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

// ============================================================================
// Helper Functions (avoid top-level await)
// ============================================================================

async function getRouterModule() {
  try {
    return await import('../ruvector/q-learning-router.js');
  } catch {
    return null;
  }
}

async function getRuVectorModule() {
  try {
    return await import('../ruvector/index.js');
  } catch {
    return null;
  }
}

// ============================================================================
// Route Subcommand
// ============================================================================

const routeTaskCommand: Command = {
  name: 'task',
  description: 'Route a task to the optimal agent using Q-Learning',
  options: [
    {
      name: 'q-learning',
      short: 'q',
      description: 'Use Q-Learning for agent selection (default: true)',
      type: 'boolean',
      default: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Force specific agent (bypasses Q-Learning)',
      type: 'string',
    },
    {
      name: 'explore',
      short: 'e',
      description: 'Enable exploration (random selection chance)',
      type: 'boolean',
      default: true,
    },
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route task "implement authentication"', description: 'Route task to best agent' },
    { command: 'claude-flow route task "write unit tests" --q-learning', description: 'Use Q-Learning routing' },
    { command: 'claude-flow route task "review code" --agent reviewer', description: 'Force specific agent' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskDescription = ctx.args[0];
    const forceAgent = ctx.flags.agent as string | undefined;
    const useExploration = ctx.flags.explore as boolean;
    const jsonOutput = ctx.flags.json as boolean;

    if (!taskDescription) {
      output.printError('Task description is required');
      output.writeln(output.dim('Usage: claude-flow route task "task description"'));
      return { success: false, exitCode: 1 };
    }

    const routerModule = await getRouterModule();
    if (!routerModule) {
      output.printError('Router module not available');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: 'Analyzing task...', spinner: 'dots' });
    spinner.start();

    try {
      if (forceAgent) {
        // Bypass Q-Learning, use specified agent
        const agents = await routerModule.listAgentTypes();
        const agent = agents.find(a => a.id === forceAgent || a.name.toLowerCase() === forceAgent.toLowerCase());

        if (!agent) {
          spinner.fail(`Agent "${forceAgent}" not found`);
          output.writeln();
          output.writeln('Available agents:');
          output.printList(agents.map(a => `${output.highlight(a.id)} - ${a.description}`));
          return { success: false, exitCode: 1 };
        }

        spinner.succeed(`Routed to ${agent.name}`);

        if (jsonOutput) {
          output.printJson({
            task: taskDescription,
            agentId: agent.id,
            agentName: agent.name,
            confidence: 1.0,
            method: 'forced',
          });
        } else {
          output.writeln();
          output.printBox([
            `Task: ${taskDescription}`,
            `Agent: ${output.highlight(agent.name)} (${agent.id})`,
            `Confidence: ${output.success('100%')} (forced)`,
            `Description: ${agent.description}`,
          ].join('\n'), 'Routing Result');
        }

        return { success: true, data: { agentId: agent.id, agentName: agent.name } };
      }

      // Use Q-Learning routing
      const result = await routerModule.routeTask(taskDescription, useExploration);

      spinner.succeed(`Routed to ${result.agentType.name}`);

      if (jsonOutput) {
        output.printJson({
          task: taskDescription,
          agentId: result.agentId,
          agentName: result.agentType.name,
          confidence: result.confidence,
          qValue: result.qValue,
          explorationUsed: result.explorationUsed,
          alternatives: result.alternatives.map(a => ({
            agentId: a.agentId,
            agentName: a.agentType.name,
            confidence: a.confidence,
            qValue: a.qValue,
          })),
        });
      } else {
        output.writeln();

        const confidenceColor = result.confidence >= 0.7
          ? output.success
          : result.confidence >= 0.4
            ? output.warning
            : output.error;

        output.printBox([
          `Task: ${taskDescription}`,
          ``,
          `Agent: ${output.highlight(result.agentType.name)} (${result.agentId})`,
          `Confidence: ${confidenceColor(`${(result.confidence * 100).toFixed(1)}%`)}`,
          `Q-Value: ${result.qValue.toFixed(3)}`,
          `Exploration: ${result.explorationUsed ? output.warning('Yes') : 'No'}`,
          ``,
          `Description: ${result.agentType.description}`,
          `Capabilities: ${result.agentType.capabilities.join(', ')}`,
        ].join('\n'), 'Q-Learning Routing');

        if (result.alternatives.length > 0) {
          output.writeln();
          output.writeln(output.bold('Alternatives:'));
          output.printTable({
            columns: [
              { key: 'agent', header: 'Agent', width: 20 },
              { key: 'confidence', header: 'Confidence', width: 12, align: 'right' },
              { key: 'qValue', header: 'Q-Value', width: 10, align: 'right' },
            ],
            data: result.alternatives.map(a => ({
              agent: a.agentType.name,
              confidence: `${(a.confidence * 100).toFixed(1)}%`,
              qValue: a.qValue.toFixed(3),
            })),
          });
        }
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Routing failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// List Agents Subcommand
// ============================================================================

const listAgentsCommand: Command = {
  name: 'list-agents',
  aliases: ['agents', 'ls'],
  description: 'List all available agent types for routing',
  options: [
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route list-agents', description: 'List all agents' },
    { command: 'claude-flow route agents --json', description: 'List agents as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json as boolean;

    const routerModule = await getRouterModule();
    if (!routerModule) {
      output.printError('Router module not available');
      return { success: false, exitCode: 1 };
    }

    try {
      const agents = await routerModule.listAgentTypes();

      if (jsonOutput) {
        output.printJson(agents);
      } else {
        output.writeln();
        output.writeln(output.bold('Available Agent Types'));
        output.writeln(output.dim('Ordered by priority (highest first)'));
        output.writeln();

        output.printTable({
          columns: [
            { key: 'id', header: 'ID', width: 20 },
            { key: 'name', header: 'Name', width: 20 },
            { key: 'priority', header: 'Priority', width: 10, align: 'right' },
            { key: 'description', header: 'Description', width: 40 },
          ],
          data: agents.map(a => ({
            id: output.highlight(a.id),
            name: a.name,
            priority: String(a.priority),
            description: a.description,
          })),
        });

        output.writeln();
        output.writeln(output.dim(`Total: ${agents.length} agent types`));
      }

      return { success: true, data: agents };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Stats Subcommand
// ============================================================================

const statsCommand: Command = {
  name: 'stats',
  description: 'Show Q-Learning router statistics',
  options: [
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route stats', description: 'Show routing statistics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json as boolean;

    const routerModule = await getRouterModule();
    const ruvectorModule = await getRuVectorModule();

    if (!routerModule) {
      output.printError('Router module not available');
      return { success: false, exitCode: 1 };
    }

    try {
      const stats = await routerModule.getRouterStats();
      const ruvectorStatus = ruvectorModule?.getStatus?.() ?? {
        available: false,
        wasmAccelerated: false,
        backend: 'fallback',
      };

      if (jsonOutput) {
        output.printJson({ stats, ruvector: ruvectorStatus });
      } else {
        output.writeln();
        output.writeln(output.bold('Q-Learning Router Statistics'));
        output.writeln();

        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' },
          ],
          data: [
            { metric: 'Total Routes', value: String(stats.totalRoutes) },
            { metric: 'Successful Routes', value: String(stats.successfulRoutes) },
            { metric: 'Success Rate', value: stats.totalRoutes > 0
              ? `${((stats.successfulRoutes / stats.totalRoutes) * 100).toFixed(1)}%`
              : 'N/A' },
            { metric: 'Avg Confidence', value: `${(stats.avgConfidence * 100).toFixed(1)}%` },
            { metric: 'Avg Execution Time', value: `${stats.avgExecutionTime.toFixed(0)}ms` },
            { metric: 'Q-Table Size', value: String(stats.qTableSize) },
            { metric: 'Epsilon', value: stats.epsilon.toFixed(3) },
            { metric: 'Backend', value: stats.backend },
          ],
        });

        if (Object.keys(stats.agentUsage).length > 0) {
          output.writeln();
          output.writeln(output.bold('Agent Usage'));
          output.printTable({
            columns: [
              { key: 'agent', header: 'Agent', width: 20 },
              { key: 'count', header: 'Routes', width: 10, align: 'right' },
              { key: 'percentage', header: '%', width: 10, align: 'right' },
            ],
            data: Object.entries(stats.agentUsage)
              .sort((a, b) => b[1] - a[1])
              .map(([agent, count]) => ({
                agent,
                count: String(count),
                percentage: `${((count / stats.totalRoutes) * 100).toFixed(1)}%`,
              })),
          });
        }

        output.writeln();
        output.writeln(output.bold('RuVector Status'));
        output.printList([
          `Available: ${ruvectorStatus.available ? output.success('Yes') : output.warning('No (using fallback)')}`,
          `WASM Accelerated: ${ruvectorStatus.wasmAccelerated ? output.success('Yes') : 'No'}`,
          `Backend: ${ruvectorStatus.backend}`,
        ]);
      }

      return { success: true, data: { stats, ruvector: ruvectorStatus } };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Feedback Subcommand
// ============================================================================

const feedbackCommand: Command = {
  name: 'feedback',
  description: 'Provide feedback on a routing decision',
  options: [
    {
      name: 'task-id',
      short: 't',
      description: 'Task identifier',
      type: 'string',
      required: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Agent that was used',
      type: 'string',
      required: true,
    },
    {
      name: 'success',
      short: 's',
      description: 'Whether the routing was successful',
      type: 'boolean',
      default: true,
    },
    {
      name: 'quality',
      short: 'q',
      description: 'Quality score (0-1)',
      type: 'number',
      default: 0.8,
    },
    {
      name: 'time',
      description: 'Execution time in milliseconds',
      type: 'number',
      default: 1000,
    },
  ],
  examples: [
    { command: 'claude-flow route feedback -t "auth-impl" -a coder -s true -q 0.9', description: 'Positive feedback' },
    { command: 'claude-flow route feedback -t "test-write" -a tester -s false', description: 'Negative feedback' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = ctx.flags['task-id'] as string;
    const agentId = ctx.flags.agent as string;
    const success = ctx.flags.success as boolean;
    const quality = ctx.flags.quality as number;
    const executionTime = ctx.flags.time as number;

    if (!taskId || !agentId) {
      output.printError('Task ID and agent are required');
      return { success: false, exitCode: 1 };
    }

    const routerModule = await getRouterModule();
    if (!routerModule) {
      output.printError('Router module not available');
      return { success: false, exitCode: 1 };
    }

    try {
      await routerModule.provideFeedback({
        taskId,
        agentId,
        success,
        quality: Math.max(0, Math.min(1, quality)),
        executionTimeMs: executionTime,
      });

      output.printSuccess(`Feedback recorded for task "${taskId}"`);
      output.writeln();
      output.printBox([
        `Task: ${taskId}`,
        `Agent: ${agentId}`,
        `Success: ${success ? output.success('Yes') : output.error('No')}`,
        `Quality: ${(quality * 100).toFixed(0)}%`,
        `Time: ${executionTime}ms`,
      ].join('\n'), 'Feedback Recorded');

      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Reset Subcommand
// ============================================================================

const resetCommand: Command = {
  name: 'reset',
  description: 'Reset the Q-Learning router state',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force reset without confirmation',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route reset', description: 'Reset router state' },
    { command: 'claude-flow route reset --force', description: 'Force reset' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;

    if (!force && ctx.interactive) {
      output.printWarning('This will reset all learned Q-values and statistics.');
      output.writeln(output.dim('Use --force to skip this confirmation.'));
      return { success: false, exitCode: 1 };
    }

    const routerModule = await getRouterModule();
    if (!routerModule) {
      output.printError('Router module not available');
      return { success: false, exitCode: 1 };
    }

    try {
      const router = await routerModule.getRouter();
      router.reset();
      output.printSuccess('Q-Learning router state has been reset');
      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Main Route Command
// ============================================================================

export const routeCommand: Command = {
  name: 'route',
  description: 'Intelligent task-to-agent routing using Q-Learning',
  subcommands: [routeTaskCommand, listAgentsCommand, statsCommand, feedbackCommand, resetCommand],
  options: [
    {
      name: 'q-learning',
      short: 'q',
      description: 'Use Q-Learning for agent selection',
      type: 'boolean',
      default: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Force specific agent',
      type: 'string',
    },
  ],
  examples: [
    { command: 'claude-flow route "implement feature"', description: 'Route task to best agent' },
    { command: 'claude-flow route "write tests" --q-learning', description: 'Use Q-Learning routing' },
    { command: 'claude-flow route --agent coder "fix bug"', description: 'Force specific agent' },
    { command: 'claude-flow route list-agents', description: 'List available agents' },
    { command: 'claude-flow route stats', description: 'Show routing statistics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // If task description provided directly, route it
    if (ctx.args.length > 0) {
      return routeTaskCommand.action!(ctx);
    }

    // Show help
    output.writeln();
    output.writeln(output.bold('Q-Learning Agent Router'));
    output.writeln(output.dim('Intelligent task-to-agent routing using reinforcement learning'));
    output.writeln();

    output.writeln('Usage: claude-flow route <task> [options]');
    output.writeln('       claude-flow route <subcommand>');
    output.writeln();

    output.writeln(output.bold('Subcommands:'));
    output.printList([
      `${output.highlight('task')}         - Route a task to optimal agent`,
      `${output.highlight('list-agents')}  - List available agent types`,
      `${output.highlight('stats')}        - Show router statistics`,
      `${output.highlight('feedback')}     - Provide routing feedback`,
      `${output.highlight('reset')}        - Reset router state`,
    ]);
    output.writeln();

    output.writeln(output.bold('How It Works:'));
    output.printList([
      'Analyzes task description using semantic embeddings',
      'Uses Q-Learning to learn from routing outcomes',
      'Epsilon-greedy exploration for continuous improvement',
      'Provides confidence scores and alternatives',
    ]);
    output.writeln();

    // Show quick status
    const ruvectorModule = await getRuVectorModule();
    const status = ruvectorModule?.getStatus?.() ?? { available: false, backend: 'fallback' };

    output.writeln(output.bold('Backend Status:'));
    output.printList([
      `RuVector: ${status.available ? output.success('Available') : output.warning('Fallback mode')}`,
      `Backend: ${status.backend}`,
    ]);
    output.writeln();

    output.writeln(output.dim('Run "claude-flow route <subcommand> --help" for more info'));

    return { success: true };
  },
};

export default routeCommand;
