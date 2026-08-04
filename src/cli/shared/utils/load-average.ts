/**
 * Load average — measurable on Unix, absent on Windows (Rule #1, #1358).
 *
 * `os.loadavg()` is a Unix concept. Node documents it as **always** returning
 * `[0, 0, 0]` on Windows: not an error, not `NaN`, a confident triple of zeros
 * that is indistinguishable from a genuinely idle machine. Every consumer of
 * `os.loadavg()` therefore has to decide what "no reading" means, and before
 * #1358 four of them decided it by accident — three printed a fabricated
 * `0.00` and one used it as a scheduling input, where `0 > maxCpuLoad` is
 * unreachable for any positive threshold.
 *
 * This module exists so that decision is made once. Callers ask whether a
 * reading exists and get `null` when it does not — absent beats invented
 * (#1349, #1354).
 */

/**
 * True where `os.loadavg()` returns a real measurement.
 *
 * `platform` is an explicit parameter, not a read of `process.platform` inside
 * the branch, so the Windows path is provable from the Ubuntu runner that runs
 * the unit suite. A `process.platform === 'win32'` fork *inside a test* is dead
 * code on two of the three legs and asserts nothing — the trap behind #1145 and
 * the reason #1354 introduced this parameter shape.
 *
 * This is also why `IS_WINDOWS` from `./platform.js` is deliberately not reused
 * here: it is a module-level constant baked from `process.platform` at import
 * time, so a caller could never ask "what would this do on Windows?".
 */
export function isLoadAverageMeasurable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/**
 * The 1/5/15-minute load average, or `null` where the platform has none.
 *
 * Pass the raw `os.loadavg()` result; this decides whether it means anything.
 */
export function readLoadAverage(
  loadAvg: number[],
  platform: NodeJS.Platform = process.platform,
): number[] | null {
  return isLoadAverageMeasurable(platform) ? loadAvg : null;
}

/**
 * Load average as a percentage of available cores, or `null` where it cannot
 * be measured.
 *
 * `os.cpus()` is separately documented as possibly returning an empty array,
 * which would make the division `Infinity` — a second invented number, so it
 * is `null` too.
 *
 * Introduced by #1354 in `mcp-tools/performance-tools.ts` and moved here by
 * #1358 when the third and fourth consumers appeared; that module re-exports
 * it, so its contract is unchanged.
 */
export function readCpuUsagePercent(
  loadAvg: number[],
  coreCount: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (!isLoadAverageMeasurable(platform) || coreCount === 0) return null;
  return Math.min((loadAvg[0] / coreCount) * 100, 100);
}

/** Rendered wherever a real figure is unavailable — never a zero. */
export const NOT_MEASURED = 'not measured';
