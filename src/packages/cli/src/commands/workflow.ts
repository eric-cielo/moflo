/**
 * V3 CLI Workflow Command
 * Workflow execution, validation, and template management
 *
 * Story #225: Replaced hardcoded WORKFLOW_TEMPLATES with engine registry.
 * The MCP workflow tools now call the real engine, so the CLI just
 * passes parameters through via callMCPTool().
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import type {
  WorkflowRunResponse,
  WorkflowStatusResponse,
  WorkflowListResponse,
  WorkflowCancelResponse,
  WorkflowTemplateListResponse,
  WorkflowTemplateInfoResponse,
  WorkflowErrorResponse,
} from '../mcp-tools/workflow-response.types.js';

// Shared table column definitions
const REGISTRY_COLUMNS = [
  { key: 'name', header: 'Name', width: 25 },
  { key: 'abbreviation', header: 'Abbrev', width: 10, format: (v: unknown) => v ? String(v) : '-' },
  { key: 'description', header: 'Description', width: 35, format: (v: unknown) => v ? String(v) : '' },
  { key: 'tier', header: 'Source', width: 10 },
];

const STEP_COLUMNS = [
  { key: 'stepId', header: 'Step', width: 15 },
  { key: 'stepType', header: 'Type', width: 12 },
  { key: 'status', header: 'Status', width: 12, format: formatStageStatus },
  { key: 'duration', header: 'Duration', width: 10, align: 'right' as const, format: (v: unknown) => v ? `${v}ms` : '-' },
  { key: 'error', header: 'Error', width: 30, format: (v: unknown) => v ? String(v) : '' },
];

function printWorkflowErrors(errors: WorkflowErrorResponse[]): void {
  if (errors.length === 0) return;
  output.writeln();
  output.writeln(output.bold(output.error('Errors')));
  for (const e of errors) {
    output.writeln(output.error(`  [${e.code}] ${e.message}`));
  }
}

// Run subcommand
const runCommand: Command = {
  name: 'run',
  description: 'Execute a workflow',
  options: [
    {
      name: 'name',
      short: 'n',
      description: 'Workflow name or abbreviation (resolved via registry)',
      type: 'string',
    },
    {
      name: 'file',
      short: 'f',
      description: 'Workflow definition file (YAML/JSON)',
      type: 'string',
    },
    {
      name: 'dry-run',
      short: 'd',
      description: 'Validate without executing',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'moflo workflow run -n development', description: 'Run workflow by name' },
    { command: 'moflo workflow run -f ./workflow.yaml', description: 'Run from file' },
    { command: 'moflo workflow run -n sa --dry-run', description: 'Validate via abbreviation' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const name = (ctx.flags.name as string) || ctx.args[0];
    const file = ctx.flags.file as string;
    const dryRun = ctx.flags.dryRun as boolean;
    const args = (ctx.flags.args as unknown as Record<string, unknown>) ?? {};

    if (!name && !file) {
      // Interactive: list available workflows and let user pick
      if (ctx.interactive) {
        try {
          const listResult = await callMCPTool<WorkflowListResponse>('workflow_list', { source: 'registry' });

          const defs = listResult.definitions ?? [];
          if (defs.length === 0) {
            output.printInfo('No workflow definitions found in the registry.');
            output.printInfo('Add YAML/JSON files to workflows/ or .claude/workflows/ in your project.');
            return { success: false, exitCode: 1 };
          }

          output.writeln();
          output.writeln(output.bold('Available Workflows'));
          output.writeln();
          output.printTable({ columns: REGISTRY_COLUMNS, data: defs });

          output.writeln();
          const chosen = await input({ message: 'Enter workflow name or abbreviation:' });
          if (!chosen) {
            return { success: false, exitCode: 1 };
          }

          // Re-run with chosen name
          const result = await runCommand.action!({ ...ctx, flags: { ...ctx.flags, name: chosen } });
          return result ?? { success: false, exitCode: 1 };
        } catch {
          output.printError('Workflow name or file is required. Use --name or --file');
          return { success: false, exitCode: 1 };
        }
      }

      output.printError('Workflow name or file is required. Use --name or --file');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    if (dryRun) {
      output.writeln(output.warning('DRY RUN MODE - No changes will be made'));
    }
    output.writeln(output.bold(`Workflow: ${name || file}`));
    output.writeln();

    const spinner = output.createSpinner({ text: 'Running workflow...', spinner: 'dots' });

    try {
      spinner.start();

      const result = await callMCPTool<WorkflowRunResponse>('workflow_run', {
        name: name || undefined,
        file: file || undefined,
        args,
        dryRun,
      });

      if (result.error) {
        spinner.fail(`Workflow failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      if (dryRun) {
        spinner.succeed('Workflow validated successfully');
      } else {
        spinner.succeed(result.success ? 'Workflow completed' : 'Workflow finished with errors');
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: result.success, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `ID: ${result.workflowId}`,
          `Status: ${result.success ? 'succeeded' : 'failed'}`,
          `Steps: ${result.stepCount}`,
          `Duration: ${(result.duration / 1000).toFixed(1)}s`,
        ].join('\n'),
        'Workflow Result',
      );

      if (result.steps.length > 0) {
        output.writeln();
        output.writeln(output.bold('Steps'));
        output.printTable({ columns: STEP_COLUMNS, data: result.steps });
      }

      printWorkflowErrors(result.errors);

      return { success: result.success, data: result };
    } catch (error) {
      spinner.fail('Workflow failed');
      if (error instanceof MCPClientError) {
        output.printError(`Workflow error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Validate subcommand
const validateCommand: Command = {
  name: 'validate',
  description: 'Validate a workflow definition',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Workflow definition file',
      type: 'string',
      required: true,
    },
  ],
  examples: [
    { command: 'moflo workflow validate -f ./workflow.yaml', description: 'Validate workflow file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const file = (ctx.flags.file as string) || ctx.args[0];

    if (!file) {
      output.printError('Workflow file is required. Use --file or -f');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Validating: ${file}`);

    try {
      const result = await callMCPTool<WorkflowRunResponse>('workflow_run', {
        file,
        dryRun: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: result.success, data: result };
      }

      if (result.success) {
        output.printSuccess(`Workflow is valid (${result.steps.length} steps)`);
      } else {
        output.printError('Workflow validation failed');
        printWorkflowErrors(result.errors);
      }

      return { success: result.success, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Validation error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// List subcommand
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List workflows (registry definitions and recent runs)',
  options: [
    {
      name: 'source',
      short: 's',
      description: 'What to list: registry, runs, or all',
      type: 'string',
      choices: ['registry', 'runs', 'all'],
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum results',
      type: 'number',
      default: 20,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const source = (ctx.flags.source as string) ?? 'all';
    const limit = ctx.flags.limit as number;

    try {
      const result = await callMCPTool<WorkflowListResponse>('workflow_list', { source, limit });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      if (result.definitions && result.definitions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Registry Definitions'));
        output.writeln();
        output.printTable({ columns: REGISTRY_COLUMNS, data: result.definitions });
      } else if (source === 'registry' || source === 'all') {
        output.writeln();
        if (result.registryError) {
          output.printError(`Registry: ${result.registryError}`);
        } else {
          output.printInfo('No workflow definitions found. Add YAML/JSON files to workflows/ or .claude/workflows/');
        }
      }

      if (result.runs && result.runs.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recent Runs'));
        output.writeln();
        output.printTable({
          columns: [
            { key: 'workflowId', header: 'ID', width: 20 },
            { key: 'name', header: 'Name', width: 20 },
            { key: 'status', header: 'Status', width: 12, format: formatStageStatus },
            { key: 'startedAt', header: 'Started', width: 22, format: (v) => v ? new Date(String(v)).toLocaleString() : '-' },
          ],
          data: result.runs,
        });
      } else if (source === 'runs' || source === 'all') {
        output.writeln();
        output.printInfo('No recent workflow runs');
      }

      if (result.activeWorkflows && result.activeWorkflows.length > 0) {
        output.writeln();
        output.printInfo(`Currently running: ${result.activeWorkflows.join(', ')}`);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to list workflows: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show workflow status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workflowId = ctx.args[0];

    if (!workflowId) {
      output.printError('Workflow ID is required');
      return { success: false, exitCode: 1 };
    }

    try {
      const result = await callMCPTool<WorkflowStatusResponse>('workflow_status', {
        workflowId,
        verbose: true,
      });

      if (result.error) {
        output.printError(result.error);
        return { success: false, exitCode: 1 };
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `ID: ${result.workflowId}`,
          result.name ? `Name: ${result.name}` : null,
          `Status: ${formatStageStatus(result.status)}`,
          result.progress != null ? `Progress: ${result.progress.toFixed(0)}%` : null,
          result.duration != null ? `Duration: ${(result.duration / 1000).toFixed(1)}s` : null,
        ].filter(Boolean).join('\n'),
        'Workflow Status',
      );

      if (result.steps && result.steps.length > 0) {
        output.writeln();
        output.writeln(output.bold('Steps'));
        output.printTable({ columns: STEP_COLUMNS, data: result.steps });
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Stop subcommand
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop a running workflow',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force stop without confirmation',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workflowId = ctx.args[0];
    const force = ctx.flags.force as boolean;

    if (!workflowId) {
      output.printError('Workflow ID is required');
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Cancel workflow ${workflowId}?`,
        default: false,
      });
      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    try {
      const result = await callMCPTool<WorkflowCancelResponse>('workflow_cancel', {
        workflowId,
        reason: 'Stopped via CLI',
      });

      if (result.error) {
        output.printError(result.error);
        return { success: false, exitCode: 1 };
      }

      output.printSuccess(`Workflow ${workflowId} cancelled`);
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to stop workflow: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Template subcommand
const templateCommand: Command = {
  name: 'template',
  description: 'Browse workflow templates from the registry',
  subcommands: [
    {
      name: 'list',
      description: 'List available workflow templates',
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        try {
          const result = await callMCPTool<WorkflowTemplateListResponse>('workflow_template', { action: 'list' });

          if (result.error) {
            output.printError(result.error);
            return { success: false, exitCode: 1 };
          }

          if (ctx.flags.format === 'json') {
            output.printJson(result);
            return { success: true, data: result };
          }

          output.writeln();
          output.writeln(output.bold('Available Workflow Templates'));
          output.writeln();

          if (result.templates.length === 0) {
            output.printInfo('No workflow definitions found.');
            output.printInfo('Add YAML/JSON files to workflows/ or .claude/workflows/ in your project.');
            return { success: true, data: result };
          }

          output.printTable({ columns: REGISTRY_COLUMNS, data: result.templates });

          output.writeln();
          output.printInfo(`Total: ${result.total} templates`);

          return { success: true, data: result };
        } catch (error) {
          if (error instanceof MCPClientError) {
            output.printError(`Failed to list templates: ${error.message}`);
          } else {
            output.printError(`Unexpected error: ${String(error)}`);
          }
          return { success: false, exitCode: 1 };
        }
      },
    },
    {
      name: 'show',
      aliases: ['info'],
      description: 'Show template details',
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const query = ctx.args[0];

        if (!query) {
          output.printError('Template name or abbreviation is required');
          return { success: false, exitCode: 1 };
        }

        try {
          const result = await callMCPTool<WorkflowTemplateInfoResponse>('workflow_template', { action: 'info', query });

          if (result.error) {
            output.printError(result.error);
            return { success: false, exitCode: 1 };
          }

          if (ctx.flags.format === 'json') {
            output.printJson(result);
            return { success: true, data: result };
          }

          output.writeln();
          output.printBox(
            [
              `Name: ${result.name}`,
              result.abbreviation ? `Abbreviation: ${result.abbreviation}` : null,
              result.description ? `Description: ${result.description}` : null,
              result.version ? `Version: ${result.version}` : null,
              `Source: ${result.tier} (${result.sourceFile})`,
              `Steps: ${result.stepCount}`,
              `Step Types: ${result.stepTypes?.join(', ') ?? 'none'}`,
            ].filter(Boolean).join('\n'),
            'Template Details',
          );

          if (result.arguments && Object.keys(result.arguments).length > 0) {
            output.writeln();
            output.writeln(output.bold('Arguments'));
            output.printTable({
              columns: [
                { key: 'name', header: 'Name', width: 20 },
                { key: 'type', header: 'Type', width: 10 },
                { key: 'required', header: 'Required', width: 10 },
                { key: 'description', header: 'Description', width: 30 },
              ],
              data: Object.entries(result.arguments).map(([name, def]) => {
                const d = def as Record<string, unknown>;
                return { name, type: d.type ?? '-', required: d.required ? 'yes' : 'no', description: d.description ?? '' };
              }),
            });
          }

          return { success: true, data: result };
        } catch (error) {
          if (error instanceof MCPClientError) {
            output.printError(`Failed to get template info: ${error.message}`);
          } else {
            output.printError(`Unexpected error: ${String(error)}`);
          }
          return { success: false, exitCode: 1 };
        }
      },
    },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Template Management'));
    output.writeln();
    output.writeln('Usage: moflo workflow template <subcommand>');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')}  - List available workflow templates`,
      `${output.highlight('show')}  - Show template details`,
    ]);

    return { success: true };
  },
};

// Main workflow command
export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Workflow execution and management',
  subcommands: [runCommand, validateCommand, listCommand, statusCommand, stopCommand, templateCommand],
  options: [],
  examples: [
    { command: 'moflo workflow run -n development', description: 'Run workflow by name' },
    { command: 'moflo workflow run -f ./workflow.yaml', description: 'Run from file' },
    { command: 'moflo workflow list', description: 'List workflows' },
    { command: 'moflo workflow template list', description: 'List registry templates' },
    { command: 'moflo workflow template show sa', description: 'Show workflow details' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Workflow Commands'));
    output.writeln();
    output.writeln('Usage: moflo workflow <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('run')}       - Execute a workflow`,
      `${output.highlight('validate')}  - Validate workflow definition`,
      `${output.highlight('list')}      - List workflows (registry + runs)`,
      `${output.highlight('status')}    - Show workflow status`,
      `${output.highlight('stop')}      - Cancel running workflow`,
      `${output.highlight('template')}  - Browse registry templates`,
    ]);
    output.writeln();
    output.writeln('Run "moflo workflow <subcommand> --help" for more info');

    return { success: true };
  },
};

// Helper functions
function formatStageStatus(status: unknown): string {
  const statusStr = String(status);
  switch (statusStr) {
    case 'completed':
    case 'succeeded':
    case 'success':
      return output.success(statusStr);
    case 'running':
    case 'in_progress':
      return output.highlight(statusStr);
    case 'pending':
    case 'waiting':
    case 'skipped':
      return output.dim(statusStr);
    case 'failed':
    case 'error':
    case 'cancelled':
      return output.error(statusStr);
    case 'validated':
      return output.success(statusStr);
    default:
      return statusStr;
  }
}

export default workflowCommand;
