/**
 * V3 CLI Spell Command
 * Spell casting, validation, and grimoire management
 *
 * Story #370: Renamed from workflow.ts to spell.ts with wizard terminology.
 * Story #225: Replaced hardcoded WORKFLOW_TEMPLATES with engine registry.
 * The MCP workflow tools now call the real engine, so the CLI just
 * passes parameters through via callMCPTool().
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm, input } from '../prompt.js';
import { callMCPTool } from '../mcp-client.js';
import type {
  WorkflowRunResponse,
  WorkflowStatusResponse,
  WorkflowListResponse,
  WorkflowCancelResponse,
  WorkflowTemplateListResponse,
  WorkflowTemplateInfoResponse,
  WorkflowErrorResponse,
} from '../mcp-tools/workflow-response.types.js';
import {
  TOOL_WORKFLOW_RUN,
  TOOL_WORKFLOW_LIST,
  TOOL_WORKFLOW_STATUS,
  TOOL_WORKFLOW_CANCEL,
  TOOL_WORKFLOW_TEMPLATE,
} from '../mcp-tools/tool-names.js';
import { formatStatus, handleMCPError } from '../services/cli-formatters.js';
import { scheduleCommand } from './spell-schedule.js';

// Re-export formatStatus as formatStageStatus for table column references
const formatStageStatus = formatStatus;

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

function printSpellErrors(errors: WorkflowErrorResponse[]): void {
  if (errors.length === 0) return;
  output.writeln();
  output.writeln(output.bold(output.error('Errors')));
  for (const e of errors) {
    output.writeln(output.error(`  [${e.code}] ${e.message}`));
  }
}

// Cast subcommand (formerly "run")
const castCommand: Command = {
  name: 'cast',
  aliases: ['run'],
  description: 'Cast a spell',
  options: [
    {
      name: 'name',
      short: 'n',
      description: 'Spell name or abbreviation (resolved via grimoire)',
      type: 'string',
    },
    {
      name: 'file',
      short: 'f',
      description: 'Spell definition file (YAML/JSON)',
      type: 'string',
    },
    {
      name: 'dry-run',
      short: 'd',
      description: 'Validate without casting',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'moflo spell cast -n development', description: 'Cast spell by name' },
    { command: 'moflo spell cast -f ./spell.yaml', description: 'Cast from file' },
    { command: 'moflo spell cast -n sa --dry-run', description: 'Validate via abbreviation' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const name = (ctx.flags.name as string) || ctx.args[0];
    const file = ctx.flags.file as string;
    const dryRun = ctx.flags.dryRun as boolean;
    const args = (ctx.flags.args as unknown as Record<string, unknown>) ?? {};

    if (!name && !file) {
      // Interactive: list available spells and let user pick
      if (ctx.interactive) {
        try {
          const listResult = await callMCPTool<WorkflowListResponse>(TOOL_WORKFLOW_LIST, { source: 'registry' });

          const defs = listResult.definitions ?? [];
          if (defs.length === 0) {
            output.printInfo('No spell definitions found in the grimoire.');
            output.printInfo('Add YAML/JSON files to workflows/ or .claude/workflows/ in your project.');
            return { success: false, exitCode: 1 };
          }

          output.writeln();
          output.writeln(output.bold('Available Spells'));
          output.writeln();
          output.printTable({ columns: REGISTRY_COLUMNS, data: defs });

          output.writeln();
          const chosen = await input({ message: 'Enter spell name or abbreviation:' });
          if (!chosen) {
            return { success: false, exitCode: 1 };
          }

          // Re-run with chosen name
          const result = await castCommand.action!({ ...ctx, flags: { ...ctx.flags, name: chosen } });
          return result ?? { success: false, exitCode: 1 };
        } catch {
          output.printError('Spell name or file is required. Use --name or --file');
          return { success: false, exitCode: 1 };
        }
      }

      output.printError('Spell name or file is required. Use --name or --file');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    if (dryRun) {
      output.writeln(output.warning('DRY RUN MODE - No changes will be made'));
    }
    output.writeln(output.bold(`Spell: ${name || file}`));
    output.writeln();

    const spinner = output.createSpinner({ text: 'Casting spell...', spinner: 'dots' });

    try {
      spinner.start();

      const result = await callMCPTool<WorkflowRunResponse>(TOOL_WORKFLOW_RUN, {
        name: name || undefined,
        file: file || undefined,
        args,
        dryRun,
      });

      if (result.error) {
        spinner.fail(`Spell failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      if (dryRun) {
        spinner.succeed('Spell validated successfully');
      } else {
        spinner.succeed(result.success ? 'Spell completed' : 'Spell finished with errors');
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
        'Spell Result',
      );

      if (result.steps.length > 0) {
        output.writeln();
        output.writeln(output.bold('Steps'));
        output.printTable({ columns: STEP_COLUMNS, data: result.steps });
      }

      printSpellErrors(result.errors);

      return { success: result.success, data: result };
    } catch (error) {
      spinner.fail('Spell failed');
      return handleMCPError(error, 'cast spell');
    }
  },
};

// Validate subcommand
const validateCommand: Command = {
  name: 'validate',
  description: 'Validate a spell definition',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Spell definition file',
      type: 'string',
      required: true,
    },
  ],
  examples: [
    { command: 'moflo spell validate -f ./spell.yaml', description: 'Validate spell file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const file = (ctx.flags.file as string) || ctx.args[0];

    if (!file) {
      output.printError('Spell file is required. Use --file or -f');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Validating: ${file}`);

    try {
      const result = await callMCPTool<WorkflowRunResponse>(TOOL_WORKFLOW_RUN, {
        file,
        dryRun: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: result.success, data: result };
      }

      if (result.success) {
        output.printSuccess(`Spell is valid (${result.steps.length} steps)`);
      } else {
        output.printError('Spell validation failed');
        printSpellErrors(result.errors);
      }

      return { success: result.success, data: result };
    } catch (error) {
      return handleMCPError(error, 'validate spell');
    }
  },
};

// List subcommand
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List spells (grimoire definitions and recent casts)',
  options: [
    {
      name: 'source',
      short: 's',
      description: 'What to list: grimoire, runs, or all',
      type: 'string',
      choices: ['grimoire', 'runs', 'all'],
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum results',
      type: 'number',
      default: 20,
    },
    {
      name: 'refresh',
      short: 'r',
      description: 'Re-scan definition files before listing (invalidate cache)',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const rawSource = (ctx.flags.source as string) ?? 'all';
    // Map wizard terminology to engine API values
    const source = rawSource === 'grimoire' ? 'registry' : rawSource;
    const limit = ctx.flags.limit as number;
    const refresh = ctx.flags.refresh as boolean;

    try {
      const result = await callMCPTool<WorkflowListResponse>(TOOL_WORKFLOW_LIST, { source, limit, refresh: refresh || undefined });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      if (result.definitions && result.definitions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Grimoire'));
        output.writeln();
        output.printTable({ columns: REGISTRY_COLUMNS, data: result.definitions });
      } else if (source === 'registry' || source === 'all') {
        output.writeln();
        if (result.registryError) {
          output.printError(`Grimoire: ${result.registryError}`);
        } else {
          output.printInfo('No spell definitions found. Add YAML/JSON files to workflows/ or .claude/workflows/');
        }
      }

      if (result.runs && result.runs.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recent Casts'));
        output.writeln();
        output.printTable({
          columns: [
            { key: 'workflowId', header: 'ID', width: 20 },
            { key: 'name', header: 'Name', width: 20 },
            { key: 'status', header: 'Status', width: 12, format: formatStageStatus },
            { key: 'startedAt', header: 'Cast At', width: 22, format: (v) => v ? new Date(String(v)).toLocaleString() : '-' },
          ],
          data: result.runs,
        });
      } else if (source === 'runs' || source === 'all') {
        output.writeln();
        output.printInfo('No recent spell casts');
      }

      if (result.activeWorkflows && result.activeWorkflows.length > 0) {
        output.writeln();
        output.printInfo(`Currently casting: ${result.activeWorkflows.join(', ')}`);
      }

      return { success: true, data: result };
    } catch (error) {
      return handleMCPError(error, 'list spells');
    }
  },
};

// Status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show spell status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workflowId = ctx.args[0];

    if (!workflowId) {
      output.printError('Spell ID is required');
      return { success: false, exitCode: 1 };
    }

    try {
      const result = await callMCPTool<WorkflowStatusResponse>(TOOL_WORKFLOW_STATUS, {
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
        'Spell Status',
      );

      if (result.steps && result.steps.length > 0) {
        output.writeln();
        output.writeln(output.bold('Steps'));
        output.printTable({ columns: STEP_COLUMNS, data: result.steps });
      }

      return { success: true, data: result };
    } catch (error) {
      return handleMCPError(error, 'get spell status');
    }
  },
};

// Stop subcommand (dispel)
const stopCommand: Command = {
  name: 'stop',
  aliases: ['dispel'],
  description: 'Stop a running spell',
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
      output.printError('Spell ID is required');
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Dispel ${workflowId}?`,
        default: false,
      });
      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    try {
      const result = await callMCPTool<WorkflowCancelResponse>(TOOL_WORKFLOW_CANCEL, {
        workflowId,
        reason: 'Dispelled via CLI',
      });

      if (result.error) {
        output.printError(result.error);
        return { success: false, exitCode: 1 };
      }

      output.printSuccess(`Spell ${workflowId} dispelled`);
      return { success: true, data: result };
    } catch (error) {
      return handleMCPError(error, 'dispel');
    }
  },
};

// Template subcommand (grimoire)
const templateCommand: Command = {
  name: 'template',
  aliases: ['grimoire'],
  description: 'Browse spell templates from the grimoire',
  subcommands: [
    {
      name: 'list',
      description: 'List available spell templates',
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        try {
          const result = await callMCPTool<WorkflowTemplateListResponse>(TOOL_WORKFLOW_TEMPLATE, { action: 'list' });

          if (result.error) {
            output.printError(result.error);
            return { success: false, exitCode: 1 };
          }

          if (ctx.flags.format === 'json') {
            output.printJson(result);
            return { success: true, data: result };
          }

          output.writeln();
          output.writeln(output.bold('Grimoire — Spell Templates'));
          output.writeln();

          if (result.templates.length === 0) {
            output.printInfo('No spell definitions found.');
            output.printInfo('Add YAML/JSON files to workflows/ or .claude/workflows/ in your project.');
            return { success: true, data: result };
          }

          output.printTable({ columns: REGISTRY_COLUMNS, data: result.templates });

          output.writeln();
          output.printInfo(`Total: ${result.total} templates`);

          return { success: true, data: result };
        } catch (error) {
          return handleMCPError(error, 'list templates');
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
          const result = await callMCPTool<WorkflowTemplateInfoResponse>(TOOL_WORKFLOW_TEMPLATE, { action: 'info', query });

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
            'Spell Details',
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
          return handleMCPError(error, 'get template info');
        }
      },
    },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Grimoire'));
    output.writeln();
    output.writeln('Usage: moflo spell template <subcommand>');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')}  - List available spell templates`,
      `${output.highlight('show')}  - Show template details`,
    ]);

    return { success: true };
  },
};

// Main spell command
export const spellCommand: Command = {
  name: 'spell',
  aliases: ['workflow'],
  description: 'Spell casting and management',
  subcommands: [castCommand, validateCommand, listCommand, statusCommand, stopCommand, templateCommand, scheduleCommand],
  options: [],
  examples: [
    { command: 'moflo spell cast -n development', description: 'Cast spell by name' },
    { command: 'moflo spell cast -f ./spell.yaml', description: 'Cast from file' },
    { command: 'moflo spell list', description: 'List spells' },
    { command: 'moflo spell template list', description: 'List grimoire templates' },
    { command: 'moflo spell template show sa', description: 'Show spell details' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Spell Commands'));
    output.writeln();
    output.writeln('Usage: moflo spell <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('cast')}      - Cast a spell`,
      `${output.highlight('validate')}  - Validate spell definition`,
      `${output.highlight('list')}      - List spells (grimoire + casts)`,
      `${output.highlight('status')}    - Show spell status`,
      `${output.highlight('stop')}      - Dispel a running spell`,
      `${output.highlight('template')}  - Browse grimoire templates`,
      `${output.highlight('schedule')}  - Manage scheduled spells`,
    ]);
    output.writeln();
    output.writeln('Run "moflo spell <subcommand> --help" for more info');

    return { success: true };
  },
};

export default spellCommand;
