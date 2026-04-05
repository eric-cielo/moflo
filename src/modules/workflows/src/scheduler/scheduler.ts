/**
 * Workflow Scheduler
 *
 * Manages scheduled workflow execution: polls for due workflows, prevents
 * overlap, tracks execution history, and handles catch-up after restarts.
 */

import type { MemoryAccessor } from '../types/step-command.types.js';
import type { WorkflowDefinition } from '../types/workflow-definition.types.js';
import type { WorkflowResult } from '../types/runner.types.js';
import type { MofloLevel } from '../types/step-command.types.js';
import type {
  WorkflowSchedule,
  ScheduleExecution,
  SchedulerOptions,
} from './schedule.types.js';
import { computeNextRun } from './cron-parser.js';
import { compareMofloLevels } from '../core/capability-validator.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_CATCH_UP_WINDOW_MS = 3_600_000; // 1 hour
const NAMESPACE_SCHEDULES = 'scheduled-workflows';
const NAMESPACE_EXECUTIONS = 'schedule-executions';

// ============================================================================
// Executor Interface (injected by the daemon/CLI)
// ============================================================================

export interface WorkflowExecutor {
  /** Execute a workflow by name with given args. Returns the result. */
  execute(workflowName: string, args: Record<string, unknown>, signal?: AbortSignal, mofloLevel?: MofloLevel): Promise<WorkflowResult>;
  /** Check if a workflow definition exists. */
  exists(workflowName: string): boolean;
}

// ============================================================================
// Scheduler Events
// ============================================================================

export type SchedulerEventType =
  | 'schedule:due'
  | 'schedule:started'
  | 'schedule:completed'
  | 'schedule:failed'
  | 'schedule:skipped'
  | 'schedule:disabled'
  | 'schedule:catchup';

export interface SchedulerEvent {
  readonly type: SchedulerEventType;
  readonly scheduleId: string;
  readonly workflowName: string;
  readonly message: string;
  readonly timestamp: number;
}

export type SchedulerListener = (event: SchedulerEvent) => void;

// ============================================================================
// WorkflowScheduler
// ============================================================================

export class WorkflowScheduler {
  private readonly memory: MemoryAccessor;
  private readonly executor: WorkflowExecutor;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly catchUpWindowMs: number;
  private readonly maxMofloLevel: MofloLevel | undefined;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runningWorkflows = new Map<string, AbortController>();
  private readonly inflightPromises = new Map<string, Promise<void>>();
  private readonly listeners: SchedulerListener[] = [];

  constructor(
    memory: MemoryAccessor,
    executor: WorkflowExecutor,
    options: SchedulerOptions = {},
  ) {
    this.memory = memory;
    this.executor = executor;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.catchUpWindowMs = options.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS;
    this.maxMofloLevel = options.maxMofloLevel;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the polling loop. Performs an initial poll immediately.
   */
  start(): void {
    if (this.pollTimer) return;
    this.poll(); // immediate first poll
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop the polling loop and cancel all running workflows.
   */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, controller] of this.runningWorkflows) {
      controller.abort();
    }
    // Wait for in-flight executions to settle before clearing state
    if (this.inflightPromises.size > 0) {
      await Promise.allSettled([...this.inflightPromises.values()]);
    }
    this.runningWorkflows.clear();
    this.inflightPromises.clear();
  }

  get isRunning(): boolean {
    return this.pollTimer !== null;
  }

  // ── Event Listeners ──────────────────────────────────────────────────────

  on(listener: SchedulerListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Prevent a throwing listener from breaking the scheduler loop
      }
    }
  }

  // ── Schedule CRUD ────────────────────────────────────────────────────────

  /**
   * Register a schedule from a workflow definition's `schedule` block.
   */
  async registerFromDefinition(
    definition: WorkflowDefinition,
    workflowPath: string,
  ): Promise<WorkflowSchedule | null> {
    if (!definition.schedule) return null;
    const { cron, interval, at, enabled } = definition.schedule;

    const now = Date.now();
    const nextRunAt = computeNextRun({ cron, interval, at }, now);

    if (nextRunAt === null) return null;

    const record: WorkflowSchedule = {
      id: `sched-def-${definition.name}`,
      workflowName: definition.name,
      workflowPath,
      cron,
      interval,
      at,
      nextRunAt,
      enabled: enabled !== false,
      createdAt: now,
      source: 'definition',
    };

    await this.memory.write(NAMESPACE_SCHEDULES, record.id, record);
    return record;
  }

  /**
   * Create an ad-hoc schedule via CLI.
   */
  async createSchedule(params: {
    workflowName: string;
    workflowPath: string;
    cron?: string;
    interval?: string;
    at?: string;
    args?: Record<string, unknown>;
  }): Promise<WorkflowSchedule> {
    const now = Date.now();
    const nextRunAt = computeNextRun({
      cron: params.cron,
      interval: params.interval,
      at: params.at,
    }, now);

    if (nextRunAt === null) {
      throw new Error('Could not compute next run time from provided schedule');
    }

    const id = `sched-adhoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: WorkflowSchedule = {
      id,
      workflowName: params.workflowName,
      workflowPath: params.workflowPath,
      cron: params.cron,
      interval: params.interval,
      at: params.at,
      args: params.args,
      nextRunAt,
      enabled: true,
      createdAt: now,
      source: 'adhoc',
    };

    await this.memory.write(NAMESPACE_SCHEDULES, record.id, record);
    return record;
  }

  /**
   * Cancel (disable) a schedule by ID.
   */
  async cancelSchedule(scheduleId: string): Promise<boolean> {
    const record = await this.getSchedule(scheduleId);
    if (!record) return false;

    const updated: WorkflowSchedule = { ...record, enabled: false };
    await this.memory.write(NAMESPACE_SCHEDULES, scheduleId, updated);

    this.emit({
      type: 'schedule:disabled',
      scheduleId,
      workflowName: record.workflowName,
      message: `Schedule ${scheduleId} disabled`,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Get a single schedule by ID.
   */
  async getSchedule(scheduleId: string): Promise<WorkflowSchedule | null> {
    const raw = await this.memory.read(NAMESPACE_SCHEDULES, scheduleId);
    return raw as WorkflowSchedule | null;
  }

  /**
   * List all schedules.
   */
  async listSchedules(): Promise<WorkflowSchedule[]> {
    const results = await this.memory.search(NAMESPACE_SCHEDULES, '*');
    return results.map(r => r.value as WorkflowSchedule);
  }

  /**
   * Get execution history for a schedule.
   */
  async getExecutionHistory(scheduleId: string, limit = 10): Promise<ScheduleExecution[]> {
    const results = await this.memory.search(NAMESPACE_EXECUTIONS, scheduleId);
    return results
      .map(r => r.value as ScheduleExecution)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  /**
   * Poll for due workflows and execute them.
   * This is the core method called by the polling loop.
   */
  async poll(): Promise<void> {
    const schedules = await this.listSchedules();
    const now = Date.now();

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;

      // Auto-disable if workflow no longer exists (cancelSchedule emits the event)
      if (!this.executor.exists(schedule.workflowName)) {
        await this.cancelSchedule(schedule.id);
        continue;
      }

      // Not due yet
      if (schedule.nextRunAt > now) continue;

      // Catch-up check: skip if missed run is too old
      if (now - schedule.nextRunAt > this.catchUpWindowMs) {
        this.emit({
          type: 'schedule:skipped',
          scheduleId: schedule.id,
          workflowName: schedule.workflowName,
          message: `Missed run is older than catch-up window (${this.catchUpWindowMs}ms) — skipping`,
          timestamp: now,
        });
        await this.advanceNextRun(schedule, now);
        continue;
      }

      // Overlap check: skip if this workflow is still running
      if (this.runningWorkflows.has(schedule.id)) {
        this.emit({
          type: 'schedule:skipped',
          scheduleId: schedule.id,
          workflowName: schedule.workflowName,
          message: 'Prior run still active — skipping overlapping execution',
          timestamp: now,
        });
        continue;
      }

      // Concurrency check
      if (this.runningWorkflows.size >= this.maxConcurrent) {
        continue; // will pick up on next poll
      }

      this.emit({
        type: 'schedule:due',
        scheduleId: schedule.id,
        workflowName: schedule.workflowName,
        message: `Workflow "${schedule.workflowName}" is due for execution`,
        timestamp: now,
      });

      const promise = this.executeScheduled(schedule, now).catch(() => {
        // Errors are already handled inside executeScheduled; suppress unhandled rejection
      });
      this.inflightPromises.set(schedule.id, promise);
    }
  }

  // ── Execution ────────────────────────────────────────────────────────────

  private async executeScheduled(schedule: WorkflowSchedule, now: number): Promise<void> {
    const controller = new AbortController();
    this.runningWorkflows.set(schedule.id, controller);

    const executionId = `exec-${schedule.id}-${now}`;
    const execution: ScheduleExecution = {
      id: executionId,
      scheduleId: schedule.id,
      workflowName: schedule.workflowName,
      startedAt: now,
      workflowId: `scheduled-${schedule.workflowName}-${now}`,
    };

    await this.memory.write(NAMESPACE_EXECUTIONS, executionId, execution);

    this.emit({
      type: 'schedule:started',
      scheduleId: schedule.id,
      workflowName: schedule.workflowName,
      message: `Started scheduled execution ${executionId}`,
      timestamp: now,
    });

    try {
      // Compute effective MoFlo level: min(scheduler-level cap, per-schedule cap)
      const effectiveLevel = this.resolveEffectiveMofloLevel(schedule.mofloLevel);

      const result = await this.executor.execute(
        schedule.workflowName,
        schedule.args ?? {},
        controller.signal,
        effectiveLevel,
      );

      const completedAt = Date.now();
      const completedExecution: ScheduleExecution = {
        ...execution,
        completedAt,
        success: result.success,
        error: result.success ? undefined : result.errors.map(e => e.message).join('; '),
        duration: completedAt - now,
      };
      await this.memory.write(NAMESPACE_EXECUTIONS, executionId, completedExecution);

      this.emit({
        type: result.success ? 'schedule:completed' : 'schedule:failed',
        scheduleId: schedule.id,
        workflowName: schedule.workflowName,
        message: result.success
          ? `Completed in ${completedExecution.duration}ms`
          : `Failed: ${completedExecution.error}`,
        timestamp: completedAt,
      });
    } catch (err) {
      const completedAt = Date.now();
      const failedExecution: ScheduleExecution = {
        ...execution,
        completedAt,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration: completedAt - now,
      };
      await this.memory.write(NAMESPACE_EXECUTIONS, executionId, failedExecution);

      this.emit({
        type: 'schedule:failed',
        scheduleId: schedule.id,
        workflowName: schedule.workflowName,
        message: `Error: ${failedExecution.error}`,
        timestamp: completedAt,
      });
    } finally {
      this.runningWorkflows.delete(schedule.id);
      this.inflightPromises.delete(schedule.id);
      await this.advanceNextRun(schedule, Date.now());
    }
  }

  /**
   * Compute the effective MoFlo level for a scheduled execution.
   * Returns the more restrictive of the scheduler-level and per-schedule caps,
   * or undefined if neither is set (preserving default behavior).
   */
  private resolveEffectiveMofloLevel(scheduleLevel?: MofloLevel): MofloLevel | undefined {
    if (!this.maxMofloLevel && !scheduleLevel) return undefined;
    if (!this.maxMofloLevel) return scheduleLevel;
    if (!scheduleLevel) return this.maxMofloLevel;
    // Return the more restrictive (lower ordinal) of the two
    return compareMofloLevels(scheduleLevel, this.maxMofloLevel) <= 0
      ? scheduleLevel
      : this.maxMofloLevel;
  }

  /**
   * Advance the schedule's nextRunAt after execution or skip.
   * For one-time (`at`) schedules, auto-disables after execution.
   */
  private async advanceNextRun(schedule: WorkflowSchedule, now: number): Promise<void> {
    // One-time schedule: disable after run
    if (schedule.at) {
      const updated: WorkflowSchedule = { ...schedule, enabled: false, lastRunAt: now };
      await this.memory.write(NAMESPACE_SCHEDULES, schedule.id, updated);
      return;
    }

    const nextRunAt = computeNextRun({
      cron: schedule.cron,
      interval: schedule.interval,
      lastRunAt: now,
    }, now);

    const updated: WorkflowSchedule = {
      ...schedule,
      lastRunAt: now,
      nextRunAt: nextRunAt ?? now + this.pollIntervalMs, // fallback shouldn't happen
    };
    await this.memory.write(NAMESPACE_SCHEDULES, schedule.id, updated);
  }
}
