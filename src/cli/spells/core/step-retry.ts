/**
 * Per-step retry — issue #1336.
 *
 * A spell step had no retry. A flaky HTTP call, a rate-limit response, or a
 * momentary network drop failed the whole run and discarded every completed
 * step, for a cause that would likely have succeeded seconds later. That hurts
 * most on the daemon-scheduled path, where a run dying at step 7 of 9 at 3am
 * produces a failed record and no work.
 *
 * Three deliberate constraints:
 *
 *   - **Opt-in per step.** Blanket retry is wrong: silently re-running a step
 *     that posts to Slack or writes a file is worse than failing. A step
 *     without a `retry` block behaves exactly as it does today.
 *   - **Only non-deterministic failures retry.** A capability violation, an
 *     unknown step type, or a schema-invalid config will fail identically on
 *     every attempt — retrying them just burns wall clock, and under #1335 it
 *     can burn a spend ceiling too. See {@link isRetryableFailure}.
 *   - **Bounded, and interruptible.** Backoff is capped per-delay and in
 *     aggregate, and the wait aborts on the run's signal — which is the
 *     budget-composed signal, so a wall-clock ceiling breach cuts a backoff
 *     short instead of being served after it.
 *
 * The credential-refresh retry in `runner.ts` is a separate concern with its
 * own semantics and takes precedence; this never wraps it.
 *
 * ## Why not `shared/resilience/retry.ts` or `production/retry.ts`
 *
 * Both already do exponential backoff, and neither fits — the mismatch is the
 * failure protocol, not the math:
 *
 *   - Both retry on a **thrown** exception. A spell step signals failure by
 *     *returning* `StepOutput.success === false`. Adapting would mean throwing
 *     the failure away to re-raise it, losing the output, the error code, and
 *     the rollback bookkeeping the executor already did.
 *   - `shared/resilience` wraps every attempt in its own `withTimeout`. Steps
 *     already own their timeout (`config.timeout` / `defaultStepTimeout`);
 *     a second one would silently shorten it.
 *   - Neither sleeps on an `AbortSignal`, which is precisely what lets a
 *     wall-clock ceiling breach cut a backoff short here.
 *
 * The shared helpers stay right for their callers. Reach for them when
 * retrying a promise that throws; reach for this when retrying a spell step.
 *
 * Cross-platform (Rule #1): pure timers and `AbortSignal`, no shell, no
 * platform branches.
 */

import type { SpellErrorCode } from '../types/runner.types.js';

// ============================================================================
// Config
// ============================================================================

export interface StepRetryConfig {
  /** Total attempts INCLUDING the first. `1` means no retry. */
  readonly attempts: number;
  /** Base delay in ms before the second attempt; doubles thereafter. */
  readonly backoffMs?: number;
  /** Ceiling on any single delay. */
  readonly maxDelayMs?: number;
  /** Ceiling on the sum of all delays for this step. */
  readonly maxTotalDelayMs?: number;
}

/** Base delay when a step declares `retry` without one. */
export const DEFAULT_BACKOFF_MS = 1_000;
/** Ceiling on any single backoff, when the step declares none. */
export const DEFAULT_MAX_DELAY_MS = 30_000;
/**
 * Ceiling on total backoff for one step, when the step declares none.
 *
 * Exists so a step cannot stall a scheduled run indefinitely (#1336 AC5) even
 * if someone writes `attempts: 50`. It bounds *waiting*, not the attempts
 * themselves — once exhausted, remaining attempts run back-to-back.
 */
export const DEFAULT_MAX_TOTAL_DELAY_MS = 60_000;

/**
 * Error codes worth a second attempt.
 *
 * Everything omitted here is deterministic: the same input produces the same
 * failure, so N attempts cost N times as much and produce one outcome.
 * `STEP_CANCELLED` is excluded for a different reason — the run is already
 * being torn down, and retrying would fight the teardown.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<SpellErrorCode>([
  'STEP_EXECUTION_FAILED',
  'STEP_TIMEOUT',
]);

/** Whether a failed step's error code justifies another attempt. */
export function isRetryableFailure(errorCode: string | undefined): boolean {
  return errorCode !== undefined && RETRYABLE_CODES.has(errorCode);
}

/**
 * Normalise a step's `retry` block.
 *
 * Returns undefined when retry is absent or resolves to a single attempt, so
 * callers can treat "no retry block" and "a retry block that does nothing"
 * identically — and so the executor takes its pre-feature code path in both
 * cases rather than looping once.
 */
export function resolveStepRetry(raw?: unknown): StepRetryConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;

  const attempts = positiveInt(rec.attempts);
  if (attempts === undefined || attempts <= 1) return undefined;

  const backoffMs = positiveInt(rec.backoffMs ?? rec.backoff_ms) ?? DEFAULT_BACKOFF_MS;
  const maxDelayMs = positiveInt(rec.maxDelayMs ?? rec.max_delay_ms) ?? DEFAULT_MAX_DELAY_MS;
  const maxTotalDelayMs =
    positiveInt(rec.maxTotalDelayMs ?? rec.max_total_delay_ms) ?? DEFAULT_MAX_TOTAL_DELAY_MS;

  return { attempts, backoffMs, maxDelayMs, maxTotalDelayMs };
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

// ============================================================================
// Backoff
// ============================================================================

export interface BackoffOptions {
  /** Randomness source for jitter, injectable so tests are deterministic. */
  readonly random?: () => number;
}

/**
 * Delay before the attempt that follows `attemptsMade` failures.
 *
 * Exponential from `backoffMs`, capped by `maxDelayMs`, then reduced so the
 * running total never exceeds `maxTotalDelayMs`. Returns 0 once the aggregate
 * budget is spent — remaining attempts still run, just without waiting.
 *
 * Jitter is +/-10%, applied before the caps. Spells have a `parallel` step
 * type, so a fan-out of steps hitting the same rate limit would otherwise
 * retry in exact lockstep and reproduce the burst that rate-limited them.
 */
export function computeBackoffMs(
  config: StepRetryConfig,
  attemptsMade: number,
  totalDelaySoFar: number,
  options: BackoffOptions = {},
): number {
  const base = config.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxDelay = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxTotal = config.maxTotalDelayMs ?? DEFAULT_MAX_TOTAL_DELAY_MS;

  const remaining = maxTotal - totalDelaySoFar;
  if (remaining <= 0) return 0;

  const exponential = base * Math.pow(2, Math.max(0, attemptsMade - 1));
  const random = options.random ?? Math.random;
  const jittered = exponential * (0.9 + random() * 0.2);

  return Math.max(0, Math.round(Math.min(jittered, maxDelay, remaining)));
}

/**
 * Wait `ms`, resolving early if `signal` aborts.
 *
 * Resolving rather than rejecting on abort is deliberate: the caller checks
 * the signal itself and returns a cancelled step result. Rejecting here would
 * make an abort during backoff look like a different failure than an abort
 * during execution, which it is not.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const timer = setTimeout(finish, ms);
    // Never hold the process open for a backoff whose run is over.
    timer.unref?.();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
