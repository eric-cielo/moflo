/**
 * V3 CLI Swarm Command
 * Swarm coordination and management commands
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, multiSelect } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY_SWARM_DIR, memoryDbCandidatePaths, mofloDir } from '../services/moflo-paths.js';
import { findProjectRoot } from '../services/project-root.js';
import { resolveStateRoot } from '../services/project-root.js';

/**
 * Persisted swarm state — the only durable thing the `flo swarm` CLI owns.
 *
 * #1428: every MCP tool the CLI can reach (`swarm_init`, `agent_spawn`,
 * `task_orchestrate`, …) runs *in-process* — `mcp-client.ts` imports the
 * handlers directly rather than talking to a server. So the coordinator a
 * one-shot CLI command builds dies when that command exits, and nothing it
 * spawned survives to be observed. The long-lived coordinator lives in the
 * MCP server, which is why the `mcp__moflo__*` tools can deploy agents and
 * the CLI cannot.
 *
 * That makes this state file the boundary of what `flo swarm` may honestly
 * claim: `init` records the topology, `start` records an objective against
 * it, `stop` clears it, and `status` reads it back. Anything beyond that has
 * to be reported as delegated to the MCP surface, not narrated as done.
 */
interface SwarmStateFile {
  id: string;
  topology?: string;
  maxAgents?: number;
  strategy?: string;
  v3Mode?: boolean;
  initializedAt?: string;
  status?: string;
  objective?: string;
  plannedAgents?: number;
  startedAt?: string;
}

/**
 * Canonical path first, then the pre-#1168 `.swarm/state.json` fallback, so a
 * consumer who initialised on an older moflo still resolves their swarm.
 * Writes only ever go to `[0]`.
 */
function swarmStateFileCandidates(): [canonical: string, legacy: string] {
  const root = findProjectRoot();
  return [
    path.join(mofloDir(root), 'swarm', 'state.json'),
    path.join(root, LEGACY_SWARM_DIR, 'state.json'),
  ];
}

function readSwarmState(): SwarmStateFile | null {
  for (const file of swarmStateFileCandidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as SwarmStateFile;
    } catch {
      // A malformed state file is treated as absent rather than fatal — the
      // remedy is `flo swarm init`, which overwrites it.
    }
  }
  return null;
}

function writeSwarmState(state: SwarmStateFile): void {
  const [canonical] = swarmStateFileCandidates();
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.writeFileSync(canonical, JSON.stringify(state, null, 2));
}

/**
 * Resolve the recorded swarm, or print why it cannot be and return null —
 * in which case the caller exits non-zero without doing anything.
 *
 * Shared by `stop` and `scale`: both must refuse an id that is not the active
 * swarm rather than acting on it, which is half of what #1428 was about.
 */
function resolveActiveSwarm(swarmId: string, missingMessage: string): SwarmStateFile | null {
  const existing = readSwarmState();
  if (!existing) {
    output.printError(missingMessage);
    output.printInfo('Run "flo swarm status" to see what is recorded for this project.');
    return null;
  }
  if (existing.id !== swarmId) {
    output.printError(`Swarm ${swarmId} is not the active swarm.`);
    output.printInfo(`Active swarm is ${existing.id} — run "flo swarm status" to confirm.`);
    return null;
  }
  return existing;
}

/** Remove both the canonical and legacy state files; returns true if any existed. */
function clearSwarmState(): boolean {
  let removed = false;
  for (const file of swarmStateFileCandidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.rmSync(file, { force: true });
      removed = true;
    } catch {
      // Leave `removed` false — the caller reports the failure rather than
      // claiming a stop that did not happen.
    }
  }
  return removed;
}

// Get dynamic swarm status from memory/session files
function getSwarmStatus(swarmId?: string) {
  const projectRoot = findProjectRoot();
  // `.moflo/swarm/state.json` is canonical post-#1168; `.swarm/state.json`
  // is a read-only fallback so a consumer who initialised on an older moflo
  // still sees their swarm. The pre-#1168 agents/tasks JSON probe blocks
  // were removed — no current writer creates those directories, so they
  // always produced 0 counts. The coordinator-backed MCP tools
  // (agent_list / task_list) are the live source of truth.
  const sessionDir = path.join(process.cwd(), '.claude', 'sessions');
  const memoryPaths = memoryDbCandidatePaths(resolveStateRoot());

  // Canonical first, then legacy — shared with init/start/stop so all four
  // subcommands resolve the same file.
  const swarmState = readSwarmState();

  // agents/tasks counters: no file-store readers post-#1168. Coordinator
  // MCP tools own the live counts; getSwarmStatus surfaces a static summary
  // of the persisted state file plus session/memory rough indicators.
  const activeAgents = 0;
  const totalAgents = 0;
  const completedTasks = 0;
  const inProgressTasks = 0;
  const pendingTasks = 0;

  // Get session count
  let sessionCount = 0;
  if (fs.existsSync(sessionDir)) {
    try {
      sessionCount = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json')).length;
    } catch {
      // Ignore
    }
  }

  // Get memory size as rough indicator of activity
  let memorySize = 0;
  for (const dbPath of memoryPaths) {
    if (fs.existsSync(dbPath)) {
      try {
        memorySize = fs.statSync(dbPath).size;
        break;
      } catch {
        // Ignore
      }
    }
  }

  // Calculate dynamic progress based on actual state
  // If no swarm state, show 0%. Otherwise calculate from completed tasks
  const totalTasks = completedTasks + inProgressTasks + pendingTasks;
  let progress = 0;
  if (totalTasks > 0) {
    progress = Math.round((completedTasks / totalTasks) * 100);
  } else if (swarmState) {
    // Swarm initialized but no tasks yet
    progress = 5;
  }

  // Determine status
  let status = 'idle';
  if (inProgressTasks > 0 || activeAgents > 0) {
    status = 'running';
  } else if (completedTasks > 0 && pendingTasks === 0 && inProgressTasks === 0) {
    status = 'completed';
  } else if (swarmState) {
    // Honour what was recorded. `start` writes `running`; `init` writes
    // `ready`. Pre-#1428 this collapsed both to `ready`, so a recorded
    // objective was invisible here.
    status = swarmState.status || 'ready';
  }

  return {
    id: swarmId || swarmState?.id || 'no-active-swarm',
    topology: swarmState?.topology || 'none',
    status,
    objective: swarmState?.objective || 'No active objective',
    strategy: swarmState?.strategy || 'none',
    agents: {
      total: totalAgents,
      active: activeAgents,
      idle: Math.max(0, totalAgents - activeAgents),
      completed: 0
    },
    progress,
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      inProgress: inProgressTasks,
      pending: pendingTasks
    },
    metrics: {
      tokensUsed: 0,
      avgResponseTime: '--',
      successRate: totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : '--',
      elapsedTime: '--'
    },
    coordination: {
      consensusRounds: 0,
      messagesSent: 0,
      conflictsResolved: 0
    },
    hasActiveSwarm: !!swarmState || totalAgents > 0
  };
}

// Swarm topologies
const TOPOLOGIES = [
  { value: 'hierarchical', label: 'Hierarchical', hint: 'Queen-led coordination with worker agents' },
  { value: 'mesh', label: 'Mesh', hint: 'Fully connected peer-to-peer network' },
  { value: 'ring', label: 'Ring', hint: 'Circular communication pattern' },
  { value: 'star', label: 'Star', hint: 'Central coordinator with spoke agents' },
  { value: 'hybrid', label: 'Hybrid', hint: 'Hierarchical mesh for maximum flexibility' },
  { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', hint: 'V3 15-agent queen + peer communication (recommended)' }
];

// Swarm strategies
const STRATEGIES = [
  { value: 'specialized', label: 'Specialized', hint: 'Clear roles, no overlap (anti-drift)' },
  { value: 'balanced', label: 'Balanced', hint: 'Even distribution of work' },
  { value: 'adaptive', label: 'Adaptive', hint: 'Dynamic strategy based on task' },
  { value: 'research', label: 'Research', hint: 'Distributed research and analysis' },
  { value: 'development', label: 'Development', hint: 'Collaborative code development' },
  { value: 'testing', label: 'Testing', hint: 'Comprehensive test coverage' },
  { value: 'optimization', label: 'Optimization', hint: 'Performance optimization' },
  { value: 'maintenance', label: 'Maintenance', hint: 'Codebase maintenance and refactoring' },
  { value: 'analysis', label: 'Analysis', hint: 'Code analysis and documentation' }
];

// Initialize swarm
const initCommand: Command = {
  name: 'init',
  description: 'Initialize a new swarm',
  options: [
    {
      name: 'topology',
      short: 't',
      description: 'Swarm topology',
      type: 'string',
      choices: TOPOLOGIES.map(t => t.value),
      default: 'hierarchical'
    },
    {
      name: 'max-agents',
      short: 'm',
      description: 'Maximum number of agents',
      type: 'number',
      default: 15
    },
    {
      name: 'auto-scale',
      description: 'Enable automatic scaling',
      type: 'boolean',
      default: true
    },
    {
      name: 'strategy',
      short: 's',
      description: 'Coordination strategy',
      type: 'string',
      choices: STRATEGIES.map(s => s.value)
    },
    {
      name: 'v3-mode',
      description: 'Enable V3 15-agent hierarchical mesh mode',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let topology = ctx.flags.topology as string;
    const maxAgents = ctx.flags.maxAgents as number || 15;
    const v3Mode = ctx.flags.v3Mode as boolean;

    // V3 mode enables hierarchical-mesh hybrid
    if (v3Mode) {
      topology = 'hierarchical-mesh';
      output.printInfo('V3 Mode: Using hierarchical-mesh topology with 15-agent coordination');
    }

    // Interactive topology selection
    if (!topology && ctx.interactive) {
      topology = await select({
        message: 'Select swarm topology:',
        options: TOPOLOGIES,
        default: 'hierarchical'
      });
    }

    output.writeln();
    output.printInfo('Initializing swarm...');

    try {
      // Call MCP tool to initialize swarm
      const result = await callMCPTool<{
        swarmId: string;
        topology: string;
        initializedAt: string;
        config: {
          topology: string;
          maxAgents: number;
          currentAgents: number;
          communicationProtocol?: string;
          autoScaling?: boolean;
        };
      }>('swarm_init', {
        topology: topology as 'hierarchical' | 'mesh' | 'adaptive' | 'collective' | 'hierarchical-mesh',
        maxAgents,
        config: {
          communicationProtocol: 'message-bus',
          consensusMechanism: 'majority',
          failureHandling: 'retry',
          loadBalancing: true,
          autoScaling: ctx.flags.autoScale ?? true,
        },
        metadata: {
          v3Mode,
          strategy: ctx.flags.strategy || 'development',
        },
      });

      // Display initialization progress
      output.writeln(output.dim('  Creating coordination topology...'));
      output.writeln(output.dim('  Initializing memory namespace...'));
      output.writeln(output.dim('  Setting up communication channels...'));

      if (v3Mode) {
        output.writeln(output.dim('  Enabling Flash Attention (memory-efficient attention)...'));
        output.writeln(output.dim('  Configuring AgentDB integration (HNSW ANN search)...'));
        output.writeln(output.dim('  Initializing SONA learning system...'));
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 20 },
          { key: 'value', header: 'Value', width: 35 }
        ],
        data: [
          { property: 'Swarm ID', value: result.swarmId },
          { property: 'Topology', value: result.topology },
          { property: 'Max Agents', value: result.config.maxAgents },
          { property: 'Auto Scale', value: result.config.autoScaling ? 'Enabled' : 'Disabled' },
          { property: 'Protocol', value: result.config.communicationProtocol || 'N/A' },
          { property: 'V3 Mode', value: v3Mode ? 'Enabled' : 'Disabled' }
        ]
      });

      output.writeln();
      output.printSuccess('Swarm initialized successfully');

      // Save swarm state locally for status command to read. Post-#1168 the
      // canonical home is `<root>/.moflo/swarm/state.json`; the legacy
      // `.swarm/state.json` path is preserved as a read-only fallback in
      // `readSwarmState`.
      try {
        writeSwarmState({
          id: result.swarmId,
          topology: result.topology,
          maxAgents: result.config.maxAgents,
          strategy: (ctx.flags.strategy as string) || 'development',
          v3Mode,
          initializedAt: result.initializedAt,
          status: 'ready'
        });
      } catch {
        // Ignore errors writing state file
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to initialize swarm: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Start swarm execution
const startCommand: Command = {
  name: 'start',
  description: 'Start swarm execution',
  options: [
    {
      name: 'objective',
      short: 'o',
      description: 'Swarm objective/task',
      type: 'string',
      required: true
    },
    {
      name: 'strategy',
      short: 's',
      description: 'Execution strategy',
      type: 'string',
      choices: STRATEGIES.map(s => s.value)
    },
    {
      name: 'parallel',
      short: 'p',
      description: 'Enable parallel execution',
      type: 'boolean',
      default: true
    },
    {
      name: 'monitor',
      description: 'Enable real-time monitoring',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'flo swarm start -o "Build REST API" -s development', description: 'Start development swarm' },
    { command: 'flo swarm start -o "Analyze codebase" --parallel', description: 'Parallel analysis' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const objective = ctx.args[0] || ctx.flags.objective as string;
    let strategy = ctx.flags.strategy as string;

    if (!objective) {
      output.printError('Objective is required. Use -o or provide as argument.');
      return { success: false, exitCode: 1 };
    }

    // Interactive strategy selection
    if (!strategy && ctx.interactive) {
      strategy = await select({
        message: 'Select execution strategy:',
        options: STRATEGIES,
        default: 'development'
      });
    }

    strategy = strategy || 'development';

    // #1428 — refuse rather than narrate. Pre-fix this command printed "All
    // agents deployed" and a `flo swarm status <id>` follow-up for an id it
    // never persisted, so the advertised command reported either no active
    // swarm or the state of an unrelated earlier `init`.
    const existing = readSwarmState();
    if (!existing) {
      output.printError('No initialised swarm found.');
      output.printInfo('Run "flo swarm init" first — it records the topology this objective attaches to.');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.printInfo(`Starting swarm with objective: ${output.highlight(objective)}`);
    output.writeln();

    // Compute agent deployment plan based on strategy
    const agentPlan = getAgentPlan(strategy);

    output.writeln(output.bold('Planned Agent Roster'));
    output.printTable({
      columns: [
        { key: 'role', header: 'Role', width: 20 },
        { key: 'type', header: 'Type', width: 15 },
        { key: 'count', header: 'Count', width: 8, align: 'right' },
        { key: 'purpose', header: 'Purpose', width: 30 }
      ],
      data: agentPlan
    });

    const plannedAgents = agentPlan.reduce((sum, a) => sum + a.count, 0);

    // Confirm execution
    if (ctx.interactive) {
      const confirmed = await confirm({
        message: `Record this objective for ${plannedAgents} agents?`,
        default: true
      });

      if (!confirmed) {
        output.printInfo('Swarm execution cancelled');
        return { success: true };
      }
    }

    const startedAt = new Date().toISOString();
    const executionState = {
      // The persisted id, never a freshly-minted one — `flo swarm status`
      // resolves ids out of this same file, so a local mint was guaranteed
      // to be unresolvable.
      swarmId: existing.id,
      objective,
      strategy,
      status: 'running',
      agents: plannedAgents,
      startedAt,
      parallel: ctx.flags.parallel ?? true
    };

    try {
      writeSwarmState({
        ...existing,
        strategy,
        objective,
        plannedAgents,
        startedAt,
        status: 'running',
      });
    } catch (error) {
      output.printError(`Failed to record objective: ${String(error)}`);
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.printSuccess(`Objective recorded against swarm ${executionState.swarmId}`);
    output.writeln(output.dim(`  Monitor: flo swarm status ${executionState.swarmId}`));
    output.writeln();
    // Say plainly what did NOT happen. The CLI reaches its MCP tools in-process
    // (see SwarmStateFile above), so agents spawned here would not outlive this
    // command — the long-lived coordinator is the one inside the MCP server.
    output.printInfo('No agents were spawned by this command.');
    output.writeln(output.dim('  The roster above is a plan. Agents run on the long-lived coordinator'));
    output.writeln(output.dim('  in the MCP server — drive them from a Claude Code session with the'));
    output.writeln(output.dim('  swarm_init / agent_spawn / task_orchestrate tools.'));

    if (ctx.flags.format === 'json') {
      output.printJson(executionState);
    }

    return { success: true, data: executionState };
  }
};

// Swarm status
const statusCommand: Command = {
  name: 'status',
  description: 'Show swarm status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];

    // Get dynamic status from actual swarm state files
    const status = getSwarmStatus(swarmId);

    if (ctx.flags.format === 'json') {
      output.printJson(status);
      return { success: true, data: status };
    }

    output.writeln();

    // Show different message if no active swarm
    if (!status.hasActiveSwarm) {
      output.writeln(output.warning('No active swarm'));
      output.writeln();
      output.writeln(output.dim('Start a swarm with:'));
      output.writeln(output.dim('  npx moflo swarm init'));
      output.writeln(output.dim('  npx moflo swarm start'));
      output.writeln();
      return { success: true, data: status };
    }

    output.writeln(output.bold(`Swarm Status: ${status.id}`));
    output.writeln();

    // Progress bar
    output.writeln(`Overall Progress: ${output.progressBar(status.progress, 100, 40)}`);
    output.writeln();

    // Agent status
    output.writeln(output.bold('Agents'));
    output.printTable({
      columns: [
        { key: 'status', header: 'Status', width: 12 },
        { key: 'count', header: 'Count', width: 10, align: 'right' }
      ],
      data: [
        { status: output.success('Active'), count: status.agents.active },
        { status: output.warning('Idle'), count: status.agents.idle },
        { status: output.dim('Completed'), count: status.agents.completed },
        { status: 'Total', count: status.agents.total }
      ]
    });

    output.writeln();

    // Task status
    output.writeln(output.bold('Tasks'));
    output.printTable({
      columns: [
        { key: 'status', header: 'Status', width: 12 },
        { key: 'count', header: 'Count', width: 10, align: 'right' }
      ],
      data: [
        { status: output.success('Completed'), count: status.tasks.completed },
        { status: output.info('In Progress'), count: status.tasks.inProgress },
        { status: output.dim('Pending'), count: status.tasks.pending },
        { status: 'Total', count: status.tasks.total }
      ]
    });

    output.writeln();

    // Metrics
    output.writeln(output.bold('Performance Metrics'));
    output.printList([
      `Tokens Used: ${status.metrics.tokensUsed.toLocaleString()}`,
      `Avg Response Time: ${status.metrics.avgResponseTime}`,
      `Success Rate: ${status.metrics.successRate}`,
      `Elapsed Time: ${status.metrics.elapsedTime}`
    ]);

    output.writeln();

    // Coordination stats
    output.writeln(output.bold('Coordination'));
    output.printList([
      `Consensus Rounds: ${status.coordination.consensusRounds}`,
      `Messages Sent: ${status.coordination.messagesSent}`,
      `Conflicts Resolved: ${status.coordination.conflictsResolved}`
    ]);

    return { success: true, data: status };
  }
};

// Stop swarm
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop swarm execution',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force immediate stop',
      type: 'boolean',
      default: false
    },
    {
      name: 'save-state',
      description: 'Save current state for resume',
      type: 'boolean',
      default: true
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];
    const force = ctx.flags.force as boolean;

    if (!swarmId) {
      output.printError('Swarm ID is required. Usage: moflo swarm stop <swarm-id>');
      output.printInfo('Run "moflo swarm status" to find the active swarm ID');
      return { success: false, exitCode: 1 };
    }

    // #1428 — `stop` used to print "Swarm <id> stopped" for any string at all,
    // including an id that never existed, while leaving the state file in
    // place. It is the counterpart to `start`: if it does not clear that file,
    // `flo swarm status` reports the objective as running indefinitely.
    const existing = resolveActiveSwarm(swarmId, 'No active swarm to stop.');
    if (!existing) return { success: false, exitCode: 1 };

    if (ctx.interactive && !force) {
      const confirmed = await confirm({
        message: `Stop swarm ${swarmId}? Its recorded objective will be cleared.`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo(`Stopping swarm ${swarmId}...`);

    if (!clearSwarmState()) {
      output.printError(`Failed to clear swarm state for ${swarmId}.`);
      return { success: false, exitCode: 1 };
    }

    output.printSuccess(`Swarm ${swarmId} stopped`);
    // Only the recorded state is ours to clear — see SwarmStateFile.
    output.writeln(output.dim('  Cleared the recorded swarm state. Agents running on the MCP'));
    output.writeln(output.dim('  coordinator are unaffected — terminate those with agent_terminate.'));

    return { success: true, data: { swarmId, stopped: true, force } };
  }
};

// Scale swarm
const scaleCommand: Command = {
  name: 'scale',
  description: 'Scale swarm agent count',
  options: [
    {
      name: 'agents',
      short: 'a',
      description: 'Target number of agents',
      type: 'number',
      required: true
    },
    {
      name: 'type',
      short: 't',
      description: 'Agent type to scale',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];
    const targetAgents = ctx.flags.agents as number;
    const agentType = ctx.flags.type as string;

    if (!swarmId) {
      output.printError('Swarm ID is required. Usage: moflo swarm scale <swarm-id>');
      output.printInfo('Run "moflo swarm status" to find the active swarm ID');
      return { success: false, exitCode: 1 };
    }

    if (!targetAgents) {
      output.printError('Target agent count required. Use --agents or -a');
      return { success: false, exitCode: 1 };
    }

    // #1428 — same treatment as `start`, for the same structural reason. The
    // wired `swarm_scale` MCP tool really does call coordinator.spawnAgent /
    // terminateAgent, but calling it from here would drive a coordinator that
    // dies with this process: the agents would be spawned and lost between one
    // command and the next. Pre-fix this computed a delta against a hardcoded
    // `currentAgents = 8` and announced "Swarm scaled to N agents".
    const existing = resolveActiveSwarm(swarmId, 'No initialised swarm found.');
    if (!existing) return { success: false, exitCode: 1 };

    // The recorded ceiling, which is a real number `init` wrote — not a guess.
    const previous = existing.maxAgents;
    if (previous === targetAgents) {
      output.printInfo(`Recorded agent ceiling is already ${targetAgents}.`);
      return { success: true, data: { swarmId, agents: targetAgents, changed: false } };
    }

    try {
      writeSwarmState({ ...existing, maxAgents: targetAgents });
    } catch (error) {
      output.printError(`Failed to record agent ceiling: ${String(error)}`);
      return { success: false, exitCode: 1 };
    }

    output.printSuccess(
      `Recorded agent ceiling for ${swarmId}: ${previous ?? 'unset'} → ${targetAgents}`,
    );
    output.writeln();
    output.printInfo('No agents were spawned or terminated by this command.');
    output.writeln(output.dim('  This records the ceiling a later swarm_init will use. To scale a'));
    output.writeln(output.dim('  running swarm, call the swarm_scale MCP tool from a Claude Code'));
    output.writeln(output.dim('  session — that reaches the live coordinator, which this CLI cannot.'));

    if (agentType) {
      output.writeln(output.dim(`  --type ${agentType} applies only to live scaling via swarm_scale.`));
    }

    return {
      success: true,
      data: { swarmId, agents: targetAgents, previousAgents: previous, changed: true },
    };
  }
};

/**
 * The V3 roster `--v3-mode` is designed around. This is reference data, not
 * observed state: no agent here is running, and nothing reads it back.
 *
 * #1428 — it used to carry a per-agent `status` of `primary`/`active`/
 * `standby`, rendered in colour, which read as live telemetry for agents that
 * did not exist. The roster itself is real (the topology it describes is what
 * `swarm init --v3-mode` actually selects), so the fix is to drop the invented
 * status column rather than the table.
 */
const V3_ROSTER = [
  { id: 1, role: 'Queen Coordinator', domain: 'Orchestration' },
  { id: 2, role: 'Security Architect', domain: 'Security' },
  { id: 3, role: 'Security Auditor', domain: 'Security' },
  { id: 4, role: 'Test Architect', domain: 'Security' },
  { id: 5, role: 'Core Architect', domain: 'Core' },
  { id: 6, role: 'Memory Specialist', domain: 'Core' },
  { id: 7, role: 'Swarm Specialist', domain: 'Core' },
  { id: 8, role: 'Integration Architect', domain: 'Integration' },
  { id: 9, role: 'Performance Engineer', domain: 'Integration' },
  { id: 10, role: 'CLI Developer', domain: 'Integration' },
  { id: 11, role: 'Hooks Developer', domain: 'Integration' },
  { id: 12, role: 'MCP Specialist', domain: 'Integration' },
  { id: 13, role: 'Project Coordinator', domain: 'Management' },
  { id: 14, role: 'Documentation Lead', domain: 'Management' },
  { id: 15, role: 'DevOps Engineer', domain: 'Management' },
];

// Reference display for the V3 roster. Named `coordinate` for backward
// compatibility — it coordinates nothing, and no longer claims to.
const coordinateCommand: Command = {
  name: 'coordinate',
  description: 'Show the V3 15-agent hierarchical-mesh roster (reference only — starts nothing)',
  options: [
    {
      name: 'agents',
      description: 'Number of roster entries to show',
      type: 'number',
      default: 15
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentCount = ctx.flags.agents as number || 15;
    const roster = V3_ROSTER.slice(0, agentCount);

    output.writeln();
    output.writeln(output.bold('V3 Hierarchical-Mesh Roster (reference)'));
    output.writeln(output.dim('  The layout `flo swarm init --v3-mode` is designed around.'));
    output.writeln();

    output.printTable({
      columns: [
        { key: 'id', header: '#', width: 3, align: 'right' },
        { key: 'role', header: 'Role', width: 22 },
        { key: 'domain', header: 'Domain', width: 15 }
      ],
      data: roster
    });

    output.writeln();
    output.printInfo('No agents were started, and none are running as a result of this command.');
    output.writeln(output.dim('  Initialise the topology with: flo swarm init --v3-mode'));
    output.writeln(output.dim('  Spawn real agents from a Claude Code session with agent_spawn.'));

    if (ctx.flags.format === 'json') {
      output.printJson({ roster, count: roster.length });
    }

    return { success: true, data: { agents: roster, count: roster.length } };
  }
};

// Main swarm command
export const swarmCommand: Command = {
  name: 'swarm',
  description: 'Swarm coordination commands',
  subcommands: [initCommand, startCommand, statusCommand, stopCommand, scaleCommand, coordinateCommand],
  options: [],
  examples: [
    { command: 'flo swarm init --v3-mode', description: 'Initialize V3 swarm' },
    { command: 'flo swarm start -o "Build API" -s development', description: 'Start development swarm' },
    { command: 'flo swarm coordinate --agents 15', description: 'Show the V3 roster (reference)' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Swarm Coordination Commands'));
    output.writeln();
    output.writeln('Usage: flo swarm <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}        - Initialize a new swarm`,
      `${output.highlight('start')}       - Start swarm execution`,
      `${output.highlight('status')}      - Show swarm status`,
      `${output.highlight('stop')}        - Stop swarm execution`,
      `${output.highlight('scale')}       - Scale swarm agent count`,
      `${output.highlight('coordinate')}  - Show the V3 15-agent roster (reference)`
    ]);

    return { success: true };
  }
};

// Helper function
function getAgentPlan(strategy: string): Array<{ role: string; type: string; count: number; purpose: string }> {
  const plans: Record<string, Array<{ role: string; type: string; count: number; purpose: string }>> = {
    specialized: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Central orchestration (anti-drift)' },
      { role: 'Researcher', type: 'researcher', count: 1, purpose: 'Requirements analysis' },
      { role: 'Architect', type: 'architect', count: 1, purpose: 'System design' },
      { role: 'Coder', type: 'coder', count: 2, purpose: 'Implementation' },
      { role: 'Tester', type: 'tester', count: 1, purpose: 'Quality assurance' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Code review' }
    ],
    balanced: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate spell' },
      { role: 'Worker', type: 'coder', count: 4, purpose: 'General implementation' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Quality review' }
    ],
    adaptive: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Dynamic orchestration' },
      { role: 'Scout', type: 'researcher', count: 1, purpose: 'Task analysis' },
      { role: 'Worker', type: 'coder', count: 3, purpose: 'Adaptive execution' }
    ],
    development: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate spell' },
      { role: 'Architect', type: 'architect', count: 1, purpose: 'System design' },
      { role: 'Coder', type: 'coder', count: 3, purpose: 'Implementation' },
      { role: 'Tester', type: 'tester', count: 2, purpose: 'Quality assurance' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Code review' }
    ],
    research: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Research coordination' },
      { role: 'Researcher', type: 'researcher', count: 4, purpose: 'Data gathering' },
      { role: 'Analyst', type: 'analyst', count: 2, purpose: 'Analysis and synthesis' }
    ],
    testing: [
      { role: 'Test Lead', type: 'tester', count: 1, purpose: 'Test strategy' },
      { role: 'Unit Tester', type: 'tester', count: 2, purpose: 'Unit tests' },
      { role: 'Integration Tester', type: 'tester', count: 2, purpose: 'Integration tests' },
      { role: 'QA Reviewer', type: 'reviewer', count: 1, purpose: 'Quality review' }
    ],
    optimization: [
      { role: 'Performance Lead', type: 'optimizer', count: 1, purpose: 'Performance strategy' },
      { role: 'Profiler', type: 'analyst', count: 2, purpose: 'Profiling' },
      { role: 'Optimizer', type: 'coder', count: 2, purpose: 'Optimization' }
    ],
    maintenance: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Maintenance planning' },
      { role: 'Refactorer', type: 'coder', count: 2, purpose: 'Code cleanup' },
      { role: 'Documenter', type: 'researcher', count: 1, purpose: 'Documentation' }
    ],
    analysis: [
      { role: 'Analyst Lead', type: 'analyst', count: 1, purpose: 'Analysis coordination' },
      { role: 'Code Analyst', type: 'analyst', count: 2, purpose: 'Code analysis' },
      { role: 'Security Analyst', type: 'reviewer', count: 1, purpose: 'Security review' }
    ]
  };

  return plans[strategy] || plans.development;
}

export default swarmCommand;
