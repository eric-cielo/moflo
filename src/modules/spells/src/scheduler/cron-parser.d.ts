/**
 * Cron & Interval Parser
 *
 * Parses standard 5-field cron expressions, human-readable intervals,
 * and ISO 8601 datetimes. Computes the next run time from a reference date.
 */
import type { ValidationError } from '../types/step-command.types.js';
import type { ScheduleDefinition } from './schedule.types.js';
/**
 * Parse an interval string like "6h", "30m", "1d", "90s" into milliseconds.
 * Returns null if the format is invalid.
 */
export declare function parseInterval(interval: string): number | null;
/**
 * Compute next run time for an interval schedule.
 */
export declare function nextRunFromInterval(intervalMs: number, lastRunAt: number | undefined, now: number): number;
/**
 * Parse an ISO 8601 datetime string. Returns epoch ms or null if invalid.
 */
export declare function parseAt(at: string): number | null;
/**
 * Compute next run time for a one-time schedule. Returns the timestamp
 * if it hasn't run yet and is in the future (or within catch-up window),
 * or null if already executed or expired.
 */
export declare function nextRunFromAt(atMs: number, lastRunAt: number | undefined): number | null;
/**
 * Parsed cron expression with expanded field values.
 */
export interface ParsedCron {
    readonly minutes: ReadonlySet<number>;
    readonly hours: ReadonlySet<number>;
    readonly daysOfMonth: ReadonlySet<number>;
    readonly months: ReadonlySet<number>;
    readonly daysOfWeek: ReadonlySet<number>;
}
/**
 * Parse a standard 5-field cron expression.
 * Supports: *, ranges (1-5), lists (1,3,5), steps (star/5, 1-10/2).
 * Returns null if invalid.
 */
export declare function parseCron(expression: string): ParsedCron | null;
/**
 * Compute the next run time for a cron schedule after `after` (epoch ms).
 * Searches up to 366 days ahead. Returns epoch ms or null if no match found.
 */
export declare function nextRunFromCron(cron: ParsedCron, after: number): number | null;
export type NextRunInput = Pick<ScheduleDefinition, 'cron' | 'interval' | 'at'> & {
    lastRunAt?: number;
};
/**
 * Compute the next run time given any schedule type.
 * Returns epoch ms or null if no future run is possible.
 */
export declare function computeNextRun(input: NextRunInput, now?: number): number | null;
/**
 * Validate a schedule definition, returning errors for invalid fields.
 */
export declare function validateSchedule(schedule: ScheduleDefinition, path: string): ValidationError[];
//# sourceMappingURL=cron-parser.d.ts.map