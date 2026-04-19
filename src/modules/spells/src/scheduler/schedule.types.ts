/**
 * Spell Schedule Types
 *
 * Types for scheduled spell execution — cron, interval, and one-time scheduling.
 */

import type { MofloLevel } from '../types/step-command.types.js';

// ============================================================================
// Schedule Definition (in spell YAML/JSON)
// ============================================================================

/**
 * Schedule block for a spell definition.
 * Exactly one of `cron`, `interval`, or `at` must be specified.
 */
export interface ScheduleDefinition {
  /** Standard 5-field cron expression (minute hour day-of-month month day-of-week). */
  readonly cron?: string;
  /** Interval string: e.g., "6h", "30m", "1d", "90s". */
  readonly interval?: string;
  /** ISO 8601 datetime for one-time execution. */
  readonly at?: string;
  /** Whether the schedule is enabled (default: true). */
  readonly enabled?: boolean;
  /** MoFlo integration level cap for this schedule (narrows scheduler-level cap). */
  readonly mofloLevel?: MofloLevel;
}

// ============================================================================
// Schedule Record (persisted in memory DB)
// ============================================================================

export interface SpellSchedule {
  readonly id: string;
  readonly spellName: string;
  readonly spellPath: string;
  readonly cron?: string;
  readonly interval?: string;
  readonly at?: string;
  readonly args?: Record<string, unknown>;
  /** MoFlo integration level cap for this schedule. */
  readonly mofloLevel?: MofloLevel;
  readonly lastRunAt?: number;
  readonly nextRunAt: number;
  readonly enabled: boolean;
  readonly createdAt: number;
  /** Source: 'definition' (from YAML schedule block) or 'adhoc' (CLI-created). */
  readonly source: 'definition' | 'adhoc';
}

// ============================================================================
// Execution Record (audit trail)
// ============================================================================

export interface ScheduleExecution {
  readonly id: string;
  readonly scheduleId: string;
  readonly spellName: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly success?: boolean;
  readonly error?: string;
  readonly spellId: string;
  readonly duration?: number;
  /** True if the run was invoked via `runScheduleNow` rather than the poll loop. */
  readonly manualRun?: boolean;
}

// ============================================================================
// Scheduler Options
// ============================================================================

export interface SchedulerOptions {
  /** Poll interval in milliseconds (default: 60000 — 1 minute). */
  readonly pollIntervalMs?: number;
  /** Maximum concurrent scheduled spell executions (default: 2). */
  readonly maxConcurrent?: number;
  /** Catch-up window: max age in ms for missed runs to still execute (default: 3600000 — 1 hour). */
  readonly catchUpWindowMs?: number;
  /** Global MoFlo level cap for all scheduler-initiated spells. Per-schedule caps can only narrow, not widen. */
  readonly maxMofloLevel?: MofloLevel;
}

