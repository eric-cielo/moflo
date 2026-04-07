/**
 * Cron & Interval Parser
 *
 * Parses standard 5-field cron expressions, human-readable intervals,
 * and ISO 8601 datetimes. Computes the next run time from a reference date.
 */
// ============================================================================
// Interval Parsing
// ============================================================================
const INTERVAL_PATTERN = /^(\d+)(s|m|h|d)$/;
const INTERVAL_MULTIPLIERS = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};
/**
 * Parse an interval string like "6h", "30m", "1d", "90s" into milliseconds.
 * Returns null if the format is invalid.
 */
export function parseInterval(interval) {
    const match = interval.trim().match(INTERVAL_PATTERN);
    if (!match)
        return null;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    if (value <= 0)
        return null;
    return value * INTERVAL_MULTIPLIERS[unit];
}
/**
 * Compute next run time for an interval schedule.
 */
export function nextRunFromInterval(intervalMs, lastRunAt, now) {
    if (!lastRunAt)
        return now;
    const next = lastRunAt + intervalMs;
    return next <= now ? now : next;
}
// ============================================================================
// ISO 8601 "at" Parsing
// ============================================================================
/**
 * Parse an ISO 8601 datetime string. Returns epoch ms or null if invalid.
 */
export function parseAt(at) {
    const ts = Date.parse(at);
    if (isNaN(ts))
        return null;
    return ts;
}
/**
 * Compute next run time for a one-time schedule. Returns the timestamp
 * if it hasn't run yet and is in the future (or within catch-up window),
 * or null if already executed or expired.
 */
export function nextRunFromAt(atMs, lastRunAt) {
    if (lastRunAt)
        return null; // already ran
    return atMs;
}
const FIELD_RANGES = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6], // day of week (0=Sunday)
];
/**
 * Parse a standard 5-field cron expression.
 * Supports: *, ranges (1-5), lists (1,3,5), steps (star/5, 1-10/2).
 * Returns null if invalid.
 */
export function parseCron(expression) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5)
        return null;
    const parsed = [];
    for (let i = 0; i < 5; i++) {
        const values = parseField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
        if (!values)
            return null;
        parsed.push(values);
    }
    return {
        minutes: parsed[0],
        hours: parsed[1],
        daysOfMonth: parsed[2],
        months: parsed[3],
        daysOfWeek: parsed[4],
    };
}
function parseField(field, min, max) {
    const values = new Set();
    for (const part of field.split(',')) {
        const stepMatch = part.match(/^(.+)\/(\d+)$/);
        let range;
        let step = 1;
        if (stepMatch) {
            range = stepMatch[1];
            step = parseInt(stepMatch[2], 10);
            if (step <= 0)
                return null;
        }
        else {
            range = part;
        }
        if (range === '*') {
            for (let v = min; v <= max; v += step)
                values.add(v);
        }
        else if (range.includes('-')) {
            const [startStr, endStr] = range.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (isNaN(start) || isNaN(end) || start < min || end > max || start > end)
                return null;
            for (let v = start; v <= end; v += step)
                values.add(v);
        }
        else {
            const val = parseInt(range, 10);
            if (isNaN(val) || val < min || val > max)
                return null;
            values.add(val);
        }
    }
    return values.size > 0 ? values : null;
}
/**
 * Compute the next run time for a cron schedule after `after` (epoch ms).
 * Searches up to 366 days ahead. Returns epoch ms or null if no match found.
 */
export function nextRunFromCron(cron, after) {
    const d = new Date(after);
    // Start from the next minute
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const limit = after + 366 * 86_400_000; // 1 year max search
    while (d.getTime() <= limit) {
        const month = d.getMonth() + 1; // 1-12
        if (!cron.months.has(month)) {
            // Skip to next month
            d.setMonth(d.getMonth() + 1, 1);
            d.setHours(0, 0, 0, 0);
            continue;
        }
        const dayOfMonth = d.getDate();
        const dayOfWeek = d.getDay();
        if (!cron.daysOfMonth.has(dayOfMonth) || !cron.daysOfWeek.has(dayOfWeek)) {
            // Skip to next day
            d.setDate(d.getDate() + 1);
            d.setHours(0, 0, 0, 0);
            continue;
        }
        const hour = d.getHours();
        if (!cron.hours.has(hour)) {
            d.setHours(d.getHours() + 1, 0, 0, 0);
            continue;
        }
        const minute = d.getMinutes();
        if (!cron.minutes.has(minute)) {
            d.setMinutes(d.getMinutes() + 1, 0, 0);
            continue;
        }
        return d.getTime();
    }
    return null;
}
// Small LRU-ish cache to avoid re-parsing the same cron expression on every poll tick.
const cronCache = new Map();
const CRON_CACHE_MAX = 64;
function getCachedCron(expression) {
    const cached = cronCache.get(expression);
    if (cached)
        return cached;
    const parsed = parseCron(expression);
    if (!parsed)
        return null;
    if (cronCache.size >= CRON_CACHE_MAX) {
        // Evict oldest entry
        const firstKey = cronCache.keys().next().value;
        if (firstKey !== undefined)
            cronCache.delete(firstKey);
    }
    cronCache.set(expression, parsed);
    return parsed;
}
/**
 * Compute the next run time given any schedule type.
 * Returns epoch ms or null if no future run is possible.
 */
export function computeNextRun(input, now = Date.now()) {
    if (input.cron) {
        const parsed = getCachedCron(input.cron);
        if (!parsed)
            return null;
        const after = input.lastRunAt ?? now - 60_000; // start searching from now
        return nextRunFromCron(parsed, after > now ? after : now - 60_000);
    }
    if (input.interval) {
        const ms = parseInterval(input.interval);
        if (!ms)
            return null;
        return nextRunFromInterval(ms, input.lastRunAt, now);
    }
    if (input.at) {
        const atMs = parseAt(input.at);
        if (!atMs)
            return null;
        return nextRunFromAt(atMs, input.lastRunAt);
    }
    return null;
}
// ============================================================================
// Validation
// ============================================================================
/**
 * Validate a schedule definition, returning errors for invalid fields.
 */
export function validateSchedule(schedule, path) {
    const errors = [];
    const types = [schedule.cron, schedule.interval, schedule.at].filter(v => v !== undefined);
    if (types.length === 0) {
        errors.push({ path, message: 'schedule must specify exactly one of: cron, interval, at' });
        return errors;
    }
    if (types.length > 1) {
        errors.push({ path, message: 'schedule must specify exactly one of: cron, interval, at (found multiple)' });
    }
    if (schedule.cron !== undefined) {
        if (typeof schedule.cron !== 'string') {
            errors.push({ path: `${path}.cron`, message: 'cron must be a string' });
        }
        else if (!parseCron(schedule.cron)) {
            errors.push({ path: `${path}.cron`, message: `invalid cron expression: "${schedule.cron}"` });
        }
    }
    if (schedule.interval !== undefined) {
        if (typeof schedule.interval !== 'string') {
            errors.push({ path: `${path}.interval`, message: 'interval must be a string' });
        }
        else if (!parseInterval(schedule.interval)) {
            errors.push({ path: `${path}.interval`, message: `invalid interval: "${schedule.interval}". Use format: <number><s|m|h|d> (e.g., "6h", "30m")` });
        }
    }
    if (schedule.at !== undefined) {
        if (typeof schedule.at !== 'string') {
            errors.push({ path: `${path}.at`, message: 'at must be a string' });
        }
        else if (parseAt(schedule.at) === null) {
            errors.push({ path: `${path}.at`, message: `invalid ISO 8601 datetime: "${schedule.at}"` });
        }
    }
    if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') {
        errors.push({ path: `${path}.enabled`, message: 'enabled must be a boolean' });
    }
    return errors;
}
//# sourceMappingURL=cron-parser.js.map