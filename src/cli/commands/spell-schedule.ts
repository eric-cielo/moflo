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
import { reconcileDaemonAutostart } from '../services/daemon-autostart-lifecycle.js';
import { validateSchedule, computeNextRun } from '../spells/scheduler/cron-parser.js';

const NAMESPACE_SCHEDULES = 'scheduled-spells';
const NAMESPACE_EXECUTIONS = 'schedule-executions';
const DEFAULT_EXECUTIONS_LIMIT = 10;
const MAX_NAMESPACE_FETCH = 1000;

interface MemoryListEntry {
  readonly key: string;
  readonly namespace: string;
}

interface MemoryRetrieveResult {
  readonly value: unknown;
  readonly found?: boolean;
}

async function loadNamespaceValues<T>(namespace: string, limit = MAX_NAMESPACE_FETCH): Promise<T[]> {
  const listResult = await callMCPTool<{ entries?: MemoryListEntry[] }>(TOOL_MEMORY_LIST, {
    namespace,
    limit,
  });

  const values: T[] = [];
  for (const entry of listResult.entries ?? []) {
    try {
      const fetched = await callMCPTool<MemoryRetrieveResult>(TOOL_MEMORY_RETRIEVE, {
        namespace,
        key: entry.key,
      });
      if (fetched.value === null || fetched.value === undefined) continue;
      const parsed = typeof fetched.value === 'string'
        ? JSON.parse(fetched.value)
        : fetched.value;
      values.push(parsed as T);
    } catch {
      output.printWarning(`Skipped malformed entry: ${entry.key}`);
    }
  }
  return values;
}

/**
 * Count enabled schedules in the `scheduled-spells` namespace. Drives the
 * autostart reconcile after a create/cancel — see #960/#961.
 */
async function countEnabledSchedules(): Promise<number> {
  const records = await loadNamespaceValues<{ enabled?: boolean }>(NAMESPACE_SCHEDULES);
  return records.filter(r => r.enabled === true).length;
}

/**
 * Run the autostart reconcile and surface its message/warning to the user.
 */
function emitReconcileResult(result: ReturnType<typeof reconcileDaemonAutostart>): void {
  if (result.message) output.printInfo(result.message);
  if (result.warning) output.printWarning(result.warning);
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
    { name: 'no-autostart', description: 'Do not register the daemon as an OS login service', type: 'boolean' },
  ],
  examples: [
    { command: 'moflo spell schedule create -n audit --cron "0 9 * * *"', description: 'Daily at 9am' },
    { command: 'moflo spell schedule create -n security-audit --interval 6h', description: 'Every 6 hours' },
    { command: 'moflo spell schedule create -n report --at 2026-04-01T09:00:00Z', description: 'One-time cast' },
    { command: 'moflo spell schedule create -n audit --interval 6h --no-autostart', description: 'Skip OS login service registration (e.g., container/CI)' },
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

    const now = Date.now();
    const validation = validateSchedule({ cron, interval, at }, 'schedule');
    if (validation.length > 0) {
      output.printError(`Invalid schedule: ${validation.map(e => e.message).join(', ')}`);
      return { success: false, exitCode: 1 };
    }
    const computed = computeNextRun({ cron, interval, at }, now);
    if (computed === null) {
      output.printError('Could not compute next run time from the provided schedule');
      return { success: false, exitCode: 1 };
    }
    const nextRunAt = computed;

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
      const storeResult = await callMCPTool<{ success?: boolean; error?: string }>(TOOL_MEMORY_STORE, {
        namespace: NAMESPACE_SCHEDULES,
        key: id,
        value: JSON.stringify(record),
        upsert: true,
      });
      if (storeResult.success === false) {
        output.printError(`Failed to save schedule: ${storeResult.error ?? 'unknown error'}`);
        return { success: false, exitCode: 1 };
      }
    } catch (error) {
      return handleMCPError(error, 'save schedule');
    }

    // Reconcile OS-native autostart against the new enabled-schedule count.
    // 0→1 installs the login service; 1→2/2→3/etc. is a no-op (idempotent).
    // Note: parser normalises --no-autostart to ctx.flags.noAutostart (#787).
    const skipAutostart = ctx.flags.noAutostart === true;
    const reconcile = reconcileDaemonAutostart({
      projectRoot,
      enabledScheduleCount: await countEnabledSchedules(),
      skip: skipAutostart,
    });
    emitReconcileResult(reconcile);

    const serviceState = reconcile.transition === 'installed' || readiness.daemonInstalled
      ? 'installed'
      : 'not installed';

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
        `Service: ${serviceState}`,
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
    let raw: Array<Record<string, unknown>>;
    try {
      raw = await loadNamespaceValues<Record<string, unknown>>(NAMESPACE_SCHEDULES);
    } catch (error) {
      return handleMCPError(error, 'list schedules');
    }

    const schedules = raw.map(parsed => ({
      id: parsed.id,
      spellName: parsed.spellName,
      timing: parsed.cron || parsed.interval || parsed.at || '-',
      nextRun: parsed.nextRunAt ? new Date(parsed.nextRunAt as number).toLocaleString() : '-',
      enabled: parsed.enabled,
    }));

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
  },
};

// ── Schedule Executions ───────────────────────────────────────────────────────

const EXECUTION_COLUMNS = [
  { key: 'startedAt', header: 'Started', width: 22 },
  { key: 'spellName', header: 'Spell', width: 20 },
  { key: 'status', header: 'Status', width: 10 },
  { key: 'duration', header: 'Duration', width: 10 },
  { key: 'manualRun', header: 'Manual', width: 7 },
  { key: 'scheduleId', header: 'Schedule', width: 30 },
];

interface ExecutionRow extends Record<string, unknown> {
  id: string;
  scheduleId: string;
  spellName: string;
  startedAt: string;
  status: string;
  duration: string;
  manualRun: string;
}

function formatExecutionRow(parsed: Record<string, unknown>): ExecutionRow {
  const completed = typeof parsed.completedAt === 'number';
  let status: string;
  if (!completed) {
    status = output.warning('running');
  } else if (parsed.success === true) {
    status = output.success('success');
  } else {
    status = output.error('failed');
  }
  return {
    id: String(parsed.id ?? ''),
    scheduleId: String(parsed.scheduleId ?? ''),
    spellName: String(parsed.spellName ?? ''),
    startedAt: typeof parsed.startedAt === 'number'
      ? new Date(parsed.startedAt).toLocaleString()
      : '-',
    status,
    duration: typeof parsed.duration === 'number' ? `${parsed.duration}ms` : '-',
    manualRun: parsed.manualRun === true ? 'yes' : '',
  };
}

const executionsCommand: Command = {
  name: 'executions',
  aliases: ['exec', 'history'],
  description: 'Show recent scheduled spell executions',
  options: [
    { name: 'schedule', short: 's', description: 'Filter by schedule ID', type: 'string' },
    { name: 'limit', short: 'l', description: `Max rows to return (default ${DEFAULT_EXECUTIONS_LIMIT})`, type: 'number' },
  ],
  examples: [
    { command: 'moflo spell schedule executions', description: 'Most recent executions across all schedules' },
    { command: 'moflo spell schedule executions --schedule sched-adhoc-123', description: 'Filter by schedule ID' },
    { command: 'moflo spell schedule executions --limit 25', description: 'Show last 25 executions' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const scheduleFilter = ctx.flags.schedule as string | undefined;
    const rawLimit = ctx.flags.limit;
    const limit = typeof rawLimit === 'number' && rawLimit > 0
      ? Math.floor(rawLimit)
      : DEFAULT_EXECUTIONS_LIMIT;

    let raw: Array<Record<string, unknown>>;
    try {
      raw = await loadNamespaceValues<Record<string, unknown>>(NAMESPACE_EXECUTIONS);
    } catch (error) {
      return handleMCPError(error, 'list executions');
    }

    const parsed = raw.filter(v => typeof v.startedAt === 'number');

    const filtered = scheduleFilter
      ? parsed.filter(e => e.scheduleId === scheduleFilter)
      : parsed;
    filtered.sort((a, b) => (b.startedAt as number) - (a.startedAt as number));
    const truncated = filtered.slice(0, limit);

    if (ctx.flags.format === 'json') {
      output.printJson(truncated);
      return { success: true, data: truncated };
    }

    if (truncated.length === 0) {
      output.writeln();
      output.printInfo(scheduleFilter
        ? `No executions for schedule ${scheduleFilter}`
        : 'No scheduled spell executions yet');
      return { success: true, data: [] };
    }

    const rows = truncated.map(formatExecutionRow);

    output.writeln();
    output.writeln(output.bold(scheduleFilter
      ? `Executions for ${scheduleFilter}`
      : 'Recent Scheduled Executions'));
    output.writeln();
    output.printTable({ columns: EXECUTION_COLUMNS, data: rows });

    output.writeln();
    output.printInfo(filtered.length > truncated.length
      ? `Showing ${truncated.length} of ${filtered.length} execution(s)`
      : `Total: ${truncated.length} execution(s)`);

    return { success: true, data: truncated };
  },
};

// ── Schedule Cancel ───────────────────────────────────────────────────────────

const cancelCommand: Command = {
  name: 'cancel',
  description: 'Cancel (disable) a scheduled spell',
  options: [
    { name: 'keep-autostart', description: 'Keep the OS login service registered even if no schedules remain', type: 'boolean' },
  ],
  examples: [
    { command: 'moflo spell schedule cancel sched-adhoc-123', description: 'Cancel and auto-uninstall daemon service if no schedules remain' },
    { command: 'moflo spell schedule cancel sched-adhoc-123 --keep-autostart', description: 'Cancel but keep the OS login service registered' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const scheduleId = ctx.args[0];

    if (!scheduleId) {
      output.printError('Schedule ID is required');
      return { success: false, exitCode: 1 };
    }

    let updated: Record<string, unknown>;
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

      // Disable it. upsert:true is critical — the cancel writes back to an
      // existing key, and the historic default (insert-only) silently failed
      // with a UNIQUE constraint violation on (namespace, key) — see #962.
      updated = { ...schedule, enabled: false };
      const storeResult = await callMCPTool<{ success?: boolean; error?: string }>(TOOL_MEMORY_STORE, {
        namespace: NAMESPACE_SCHEDULES,
        key: scheduleId,
        value: JSON.stringify(updated),
        upsert: true,
      });
      if (storeResult.success === false) {
        output.printError(`Failed to cancel schedule: ${storeResult.error ?? 'unknown error'}`);
        return { success: false, exitCode: 1 };
      }
    } catch (error) {
      return handleMCPError(error, 'cancel schedule');
    }

    output.printSuccess(`Schedule ${scheduleId} cancelled`);

    // Reconcile OS-native autostart against the new enabled-schedule count.
    // 1→0 uninstalls the login service; everything else is a no-op.
    // Note: parser normalises --keep-autostart to ctx.flags.keepAutostart (#787).
    const projectRoot = ctx.cwd || process.cwd();
    const skipAutostart = ctx.flags.keepAutostart === true;
    const reconcile = reconcileDaemonAutostart({
      projectRoot,
      enabledScheduleCount: await countEnabledSchedules(),
      skip: skipAutostart,
    });
    emitReconcileResult(reconcile);

    return { success: true, data: updated };
  },
};

// ── Schedule Command (parent) ─────────────────────────────────────────────────

const SCHEDULE_DOCS_URL = 'https://github.com/eric-cielo/moflo/blob/main/docs/SPELLS.md#scheduling';

export const scheduleCommand: Command = {
  name: 'schedule',
  description: `Manage scheduled spells (full reference: ${SCHEDULE_DOCS_URL})`,
  subcommands: [createCommand, scheduleListCommand, executionsCommand, cancelCommand],
  examples: [
    { command: 'moflo spell schedule create -n audit --cron "0 9 * * *"', description: 'Schedule daily audit' },
    { command: 'moflo spell schedule list', description: 'List all schedules' },
    { command: 'moflo spell schedule executions --schedule <id>', description: 'Show execution audit trail' },
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
      `${output.highlight('create')}      - Create a scheduled spell`,
      `${output.highlight('list')}        - List all scheduled spells`,
      `${output.highlight('executions')}  - Show recent execution history`,
      `${output.highlight('cancel')}      - Cancel (disable) a schedule`,
    ]);
    output.writeln();
    output.writeln(`Full reference: ${SCHEDULE_DOCS_URL}`);

    return { success: true };
  },
};

export default scheduleCommand;
