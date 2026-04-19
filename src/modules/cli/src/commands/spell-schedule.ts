/**
 * Spell Schedule Subcommand
 *
 * CLI interface for creating, listing, and cancelling scheduled spells.
 * Includes lazy daemon readiness check on schedule creation.
 *
 * Story #370: Renamed from workflow-schedule.ts with wizard terminology.
 *
 * Schedule records are persisted to the 'scheduled-spells' memory namespace —
 * the same namespace the daemon's SpellScheduler polls. The daemon picks up
 * new schedules on its next poll cycle (or via catch-up window after restart).
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { callMCPTool } from '../mcp-client.js';
import { TOOL_MEMORY_STORE, TOOL_MEMORY_LIST, TOOL_MEMORY_RETRIEVE } from '../mcp-tools/tool-names.js';
import { handleMCPError } from '../services/cli-formatters.js';
import { ensureDaemonForScheduling } from '../services/daemon-readiness.js';

const NAMESPACE_SCHEDULES = 'scheduled-spells';

// Cached scheduler utils — resolved once on first call
let _schedulerUtils: Record<string, Function> | null | undefined;

async function getSchedulerUtils() {
  if (_schedulerUtils !== undefined) return _schedulerUtils;
  try {
    const { dirname, join } = await import('path');
    const { fileURLToPath, pathToFileURL } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const cronParserPath = join(here, '..', '..', '..', '..', 'spells', 'dist', 'scheduler', 'cron-parser.js');
    _schedulerUtils = await import(pathToFileURL(cronParserPath).href);
  } catch {
    _schedulerUtils = null;
  }
  return _schedulerUtils;
}

// ── Schedule Create ───────────────────────────────────────────────────────────

const createCommand: Command = {
  name: 'create',
  description: 'Create a scheduled spell',
  options: [
    { name: 'name', short: 'n', description: 'Spell name or abbreviation', type: 'string', required: true },
    { name: 'cron', short: 'c', description: 'Cron expression (5-field)', type: 'string' },
    { name: 'interval', short: 'i', description: 'Interval (e.g., "6h", "30m", "1d")', type: 'string' },
    { name: 'at', short: 'a', description: 'One-time ISO 8601 datetime', type: 'string' },
  ],
  examples: [
    { command: 'moflo spell schedule create -n audit --cron "0 9 * * *"', description: 'Daily at 9am' },
    { command: 'moflo spell schedule create -n security-audit --interval 6h', description: 'Every 6 hours' },
    { command: 'moflo spell schedule create -n report --at 2026-04-01T09:00:00Z', description: 'One-time cast' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const name = (ctx.flags.name as string) || ctx.args[0];
    const cron = ctx.flags.cron as string | undefined;
    const interval = ctx.flags.interval as string | undefined;
    const at = ctx.flags.at as string | undefined;

    if (!name) {
      output.printError('Spell name is required. Use --name or -n');
      return { success: false, exitCode: 1 };
    }

    const timingCount = [cron, interval, at].filter(Boolean).length;
    if (timingCount === 0) {
      output.printError('Exactly one timing option is required: --cron, --interval, or --at');
      return { success: false, exitCode: 1 };
    }
    if (timingCount > 1) {
      output.printError('Only one timing option allowed: --cron, --interval, or --at');
      return { success: false, exitCode: 1 };
    }

    const utils = await getSchedulerUtils();
    const now = Date.now();
    let nextRunAt: number;

    if (utils) {
      const validation = utils.validateSchedule({ cron, interval, at });
      if (!validation.valid) {
        output.printError(`Invalid schedule: ${validation.errors.map((e: { message: string }) => e.message).join(', ')}`);
        return { success: false, exitCode: 1 };
      }
      const computed = utils.computeNextRun({ cron, interval, at }, now);
      if (computed === null) {
        output.printError('Could not compute next run time from the provided schedule');
        return { success: false, exitCode: 1 };
      }
      nextRunAt = computed;
    } else {
      // Fallback: basic validation if spells package unavailable
      if (cron && !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(cron.trim())) {
        output.printError('Invalid cron expression: must be 5 fields (minute hour day month weekday)');
        return { success: false, exitCode: 1 };
      }
      if (interval && !/^\d+[smhd]$/.test(interval.trim())) {
        output.printError('Invalid interval: use format like "30m", "6h", "1d", "90s"');
        return { success: false, exitCode: 1 };
      }
      if (at && isNaN(Date.parse(at))) {
        output.printError('Invalid datetime: use ISO 8601 format (e.g., 2026-04-01T09:00:00Z)');
        return { success: false, exitCode: 1 };
      }
      // Approximate next run for fallback path
      if (interval) {
        const match = interval.trim().match(/^(\d+)([smhd])$/)!;
        const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
        nextRunAt = now + (Number(match[1]) * mult[match[2]]);
      } else if (at) {
        nextRunAt = Date.parse(at);
      } else {
        nextRunAt = now + 60_000;
      }
    }

    // Daemon readiness check (lazy — only on schedule creation)
    const projectRoot = ctx.cwd || process.cwd();
    const readiness = await ensureDaemonForScheduling({
      projectRoot,
      interactive: ctx.interactive,
    });

    for (const warning of readiness.warnings) {
      output.printWarning(warning);
    }

    // Always create the schedule, regardless of daemon state
    const id = `sched-adhoc-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      spellName: name,
      spellPath: '',  // resolved by scheduler at poll time
      cron,
      interval,
      at,
      nextRunAt,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    };

    try {
      await callMCPTool(TOOL_MEMORY_STORE, {
        namespace: NAMESPACE_SCHEDULES,
        key: id,
        value: JSON.stringify(record),
      });
    } catch (error) {
      return handleMCPError(error, 'save schedule');
    }

    if (ctx.flags.format === 'json') {
      output.printJson(record);
      return { success: true, data: record };
    }

    output.writeln();
    output.printSuccess('Schedule created');
    output.printBox(
      [
        `ID: ${id}`,
        `Spell: ${name}`,
        cron ? `Cron: ${cron}` : null,
        interval ? `Interval: ${interval}` : null,
        at ? `At: ${at}` : null,
        `Next Cast: ${new Date(nextRunAt).toLocaleString()}`,
        `Daemon: ${readiness.daemonRunning ? 'running' : 'not running'}`,
        `Service: ${readiness.daemonInstalled ? 'installed' : 'not installed'}`,
      ].filter(Boolean).join('\n'),
      'Scheduled Spell',
    );

    return { success: true, data: record };
  },
};

// ── Schedule List ─────────────────────────────────────────────────────────────

const SCHEDULE_COLUMNS = [
  { key: 'id', header: 'ID', width: 30 },
  { key: 'spellName', header: 'Spell', width: 20 },
  { key: 'timing', header: 'Schedule', width: 20 },
  { key: 'nextRun', header: 'Next Cast', width: 22 },
  { key: 'enabled', header: 'Enabled', width: 8, format: (v: unknown) => v ? output.success('yes') : output.error('no') },
];

const scheduleListCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all scheduled spells',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const result = await callMCPTool<{ results: Array<{ key: string; value: string }> }>(TOOL_MEMORY_LIST, {
        namespace: NAMESPACE_SCHEDULES,
      });

      // Single-pass: parse + transform for display
      const schedules: Array<Record<string, unknown>> = [];
      for (const r of result.results ?? []) {
        try {
          const parsed = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
          if (parsed) {
            schedules.push({
              id: parsed.id,
              spellName: parsed.spellName,
              timing: parsed.cron || parsed.interval || parsed.at || '-',
              nextRun: parsed.nextRunAt ? new Date(parsed.nextRunAt as number).toLocaleString() : '-',
              enabled: parsed.enabled,
            });
          }
        } catch {
          output.printWarning(`Skipped malformed schedule record: ${r.key}`);
        }
      }

      if (ctx.flags.format === 'json') {
        output.printJson(schedules);
        return { success: true, data: schedules };
      }

      if (schedules.length === 0) {
        output.writeln();
        output.printInfo('No scheduled spells');
        return { success: true, data: [] };
      }

      output.writeln();
      output.writeln(output.bold('Scheduled Spells'));
      output.writeln();
      output.printTable({ columns: SCHEDULE_COLUMNS, data: schedules });

      output.writeln();
      output.printInfo(`Total: ${schedules.length} schedule(s)`);

      return { success: true, data: schedules };
    } catch (error) {
      return handleMCPError(error, 'list schedules');
    }
  },
};

// ── Schedule Cancel ───────────────────────────────────────────────────────────

const cancelCommand: Command = {
  name: 'cancel',
  description: 'Cancel (disable) a scheduled spell',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const scheduleId = ctx.args[0];

    if (!scheduleId) {
      output.printError('Schedule ID is required');
      return { success: false, exitCode: 1 };
    }

    try {
      // Fetch the current schedule
      const fetchResult = await callMCPTool<{ value: string | null }>(TOOL_MEMORY_RETRIEVE, {
        namespace: NAMESPACE_SCHEDULES,
        key: scheduleId,
      });

      if (!fetchResult.value) {
        output.printError(`Schedule not found: ${scheduleId}`);
        return { success: false, exitCode: 1 };
      }

      const schedule = typeof fetchResult.value === 'string'
        ? JSON.parse(fetchResult.value)
        : fetchResult.value;

      // Disable it
      const updated = { ...schedule, enabled: false };
      await callMCPTool(TOOL_MEMORY_STORE, {
        namespace: NAMESPACE_SCHEDULES,
        key: scheduleId,
        value: JSON.stringify(updated),
      });

      output.printSuccess(`Schedule ${scheduleId} cancelled`);
      return { success: true, data: updated };
    } catch (error) {
      return handleMCPError(error, 'cancel schedule');
    }
  },
};

// ── Schedule Command (parent) ─────────────────────────────────────────────────

const SCHEDULE_DOCS_URL = 'https://github.com/eric-cielo/moflo/blob/main/docs/SPELLS.md#scheduling';

export const scheduleCommand: Command = {
  name: 'schedule',
  description: `Manage scheduled spells (full reference: ${SCHEDULE_DOCS_URL})`,
  subcommands: [createCommand, scheduleListCommand, cancelCommand],
  examples: [
    { command: 'moflo spell schedule create -n audit --cron "0 9 * * *"', description: 'Schedule daily audit' },
    { command: 'moflo spell schedule list', description: 'List all schedules' },
    { command: 'moflo spell schedule cancel <id>', description: 'Cancel a schedule' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Schedule Commands'));
    output.writeln();
    output.writeln('Usage: moflo spell schedule <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('create')}  - Create a scheduled spell`,
      `${output.highlight('list')}    - List all scheduled spells`,
      `${output.highlight('cancel')}  - Cancel (disable) a schedule`,
    ]);
    output.writeln();
    output.writeln(`Full reference: ${SCHEDULE_DOCS_URL}`);

    return { success: true };
  },
};

export default scheduleCommand;
