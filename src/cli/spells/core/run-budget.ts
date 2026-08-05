/**
 * Spell Run Budget — issue #1335.
 *
 * Spells spawn billed `claude -p` processes from bash steps. Nothing observed
 * or bounded that spend, and the exposure concentrates on the daemon-scheduled
 * path: a cron spell runs unattended, can invoke the model repeatedly, and a
 * misconfigured schedule or a loop step burns budget with no signal until a
 * bill arrives.
 *
 * This module bounds worst-case exposure with two ceilings:
 *
 *   - `maxModelInvocations` — how many detected `claude -p` spawns one run may
 *     make. Reserved BEFORE the process starts, so a denied invocation costs
 *     nothing.
 *   - `maxWallClockMs` — how long one run may take end to end.
 *
 * This is deliberately a **proxy for spend, not a measurement of it.** True
 * metering would mean injecting `--output-format json` into the spawned
 * `claude -p` and parsing `usage` from its stdout — which changes what a bash
 * step returns to downstream steps and breaks every spell that consumes a
 * model step's text output. The ceiling buys bounded exposure without touching
 * the `claude -p` contract.
 *
 * Both ceilings are opt-in. `createRunBudget` returns `null` when neither is
 * configured, and the runner then takes exactly the code path it takes today.
 *
 * Cross-platform (Rule #1): pure JS timers and `AbortController`, and the one
 * file read goes through `path.join` — no shell, no platform branches.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type YamlModule = { load: (s: string) => unknown; default?: { load: (s: string) => unknown } };

// ============================================================================
// Config
// ============================================================================

/**
 * Ceilings for a single spell run. Every field is optional; an object with no
 * usable field is equivalent to no budget at all.
 */
export interface SpellBudgetConfig {
  /** Max detected `claude -p` spawns per run. Unset ⇒ unlimited. */
  readonly maxModelInvocations?: number;
  /** Max wall-clock duration of the run, in ms. Unset ⇒ unlimited. */
  readonly maxWallClockMs?: number;
}

/** Which ceiling was hit. */
export type BudgetLimitKind = 'model-invocations' | 'wall-clock';

/**
 * A latched ceiling breach. Carries the numbers rather than only a message so
 * the run's `tasklist` record stays machine-readable — a reader asking "why
 * did this run stop" should not have to parse prose.
 */
export interface BudgetBreach {
  readonly kind: BudgetLimitKind;
  /** The configured ceiling. */
  readonly limit: number;
  /** What was observed when the ceiling was hit (attempt count, or elapsed ms). */
  readonly observed: number;
  /** User-facing explanation, safe to surface in logs and error messages. */
  readonly message: string;
}

/**
 * The slice of the budget a step command sees. Narrow on purpose: a step may
 * reserve an invocation and read the breach, but may not reconfigure the
 * ceiling or clear a breach.
 */
export interface RunBudgetAccessor {
  /**
   * Reserve one model invocation.
   *
   * Returns false when the ceiling is spent (or already breached), in which
   * case the caller MUST NOT spawn — the breach is latched and the runner
   * will abort the run on its next check.
   */
  tryConsumeModelInvocation(): boolean;
  /** The latched breach, or null while the run is still within its ceilings. */
  readonly breach: BudgetBreach | null;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Coerce one configured limit. Anything that is not a finite number greater
 * than zero is dropped rather than clamped: a `maxModelInvocations: 0` that
 * silently became 1 would be a ceiling the user did not ask for, and a
 * ceiling of literally zero would make every model step fail — neither is a
 * plausible reading of the config, so treating it as "unset" is the only safe
 * interpretation.
 */
function positiveLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Resolve a budget from raw `moflo.yaml` data. Accepts camelCase and
 * snake_case keys, matching `resolveSandboxConfig`.
 *
 * Returns undefined when nothing usable is configured, so callers can treat
 * "no budget block" and "a budget block full of junk" identically.
 */
export function resolveSpellBudgetConfig(raw?: unknown): SpellBudgetConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;

  const maxModelInvocations = positiveLimit(
    rec.maxModelInvocations ?? rec.max_model_invocations,
  );
  const maxWallClockMs = positiveLimit(rec.maxWallClockMs ?? rec.max_wall_clock_ms);

  if (maxModelInvocations === undefined && maxWallClockMs === undefined) return undefined;
  return {
    ...(maxModelInvocations !== undefined ? { maxModelInvocations } : {}),
    ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}),
  };
}

/**
 * Combine two budgets under "most strict wins" — the same composition rule
 * `sandbox.required` uses (#878). Either source may tighten a ceiling; neither
 * can loosen what the other requires.
 */
export function mergeSpellBudgets(
  a?: SpellBudgetConfig,
  b?: SpellBudgetConfig,
): SpellBudgetConfig | undefined {
  if (!a) return b;
  if (!b) return a;

  const pick = (x?: number, y?: number): number | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return Math.min(x, y);
  };

  const maxModelInvocations = pick(a.maxModelInvocations, b.maxModelInvocations);
  const maxWallClockMs = pick(a.maxWallClockMs, b.maxWallClockMs);
  if (maxModelInvocations === undefined && maxWallClockMs === undefined) return undefined;
  return {
    ...(maxModelInvocations !== undefined ? { maxModelInvocations } : {}),
    ...(maxWallClockMs !== undefined ? { maxWallClockMs } : {}),
  };
}

/** True when the config carries at least one enforceable ceiling. */
export function hasBudgetLimit(config?: SpellBudgetConfig): boolean {
  if (!config) return false;
  return config.maxModelInvocations !== undefined || config.maxWallClockMs !== undefined;
}

/**
 * Which execution path a run is on. The two are configured separately because
 * they carry different risk: a scheduled run is unattended and can loop
 * unobserved, while a session-attached run has a human watching it who can
 * ctrl-C. Issue #1335 requires interactive runs to stay unaffected unless the
 * user explicitly configures them, which falls out of `spells.budget.interactive`
 * being absent by default.
 */
export type SpellBudgetMode = 'scheduled' | 'interactive';

/**
 * Load the ceiling for one execution path from a project's `moflo.yaml`:
 *
 * ```yaml
 * spells:
 *   budget:
 *     scheduled:
 *       maxModelInvocations: 20
 *       maxWallClockMs: 1800000
 * ```
 *
 * Returns undefined on any failure — missing file, parse error, absent block,
 * unusable values. A budget is a safety ceiling, not a correctness
 * requirement, so an unreadable config must not stop a run that works today.
 */
export async function loadSpellBudgetFromProject(
  projectRoot: string,
  mode: SpellBudgetMode,
): Promise<SpellBudgetConfig | undefined> {
  try {
    const content = readFileSync(join(projectRoot, 'moflo.yaml'), 'utf-8');
    const mod = await import('js-yaml') as YamlModule;
    const yaml = mod.default ?? mod;
    const raw = yaml.load(content) as {
      spells?: { budget?: Record<string, unknown> };
    } | null;
    return resolveSpellBudgetConfig(raw?.spells?.budget?.[mode]);
  } catch {
    return undefined;
  }
}

// ============================================================================
// Runtime
// ============================================================================

export interface RunBudgetOptions {
  /** Caller's cancellation signal; the budget's signal aborts when it does. */
  readonly parentSignal?: AbortSignal;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A live budget for one spell run.
 *
 * Owns an {@link AbortSignal} that fires when either the caller's signal
 * aborts or the wall-clock deadline passes. The runner threads that signal
 * through to steps in place of the caller's, so a deadline breach interrupts
 * an in-flight step rather than waiting for it to return.
 */
export class SpellRunBudget implements RunBudgetAccessor {
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly deadlineAt: number | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private parentAbortListener: (() => void) | null = null;
  private parentSignal: AbortSignal | undefined;
  private invocations = 0;
  private latched: BudgetBreach | null = null;

  constructor(
    private readonly config: SpellBudgetConfig,
    options: RunBudgetOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.deadlineAt = config.maxWallClockMs !== undefined
      ? this.startedAt + config.maxWallClockMs
      : null;

    this.parentSignal = options.parentSignal;
    if (this.parentSignal) {
      if (this.parentSignal.aborted) {
        this.controller.abort();
      } else {
        this.parentAbortListener = () => this.controller.abort();
        this.parentSignal.addEventListener('abort', this.parentAbortListener, { once: true });
      }
    }

    if (config.maxWallClockMs !== undefined && !this.controller.signal.aborted) {
      this.timer = setTimeout(() => this.breachWallClock(), config.maxWallClockMs);
      // Never hold the process open for a ceiling that will be disposed when
      // the run ends. `unref` is absent on the browser-shaped timer type, so
      // it is called defensively.
      this.timer.unref?.();
    }
  }

  /** Signal to hand to steps: aborts on caller cancellation OR deadline. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get breach(): BudgetBreach | null {
    return this.latched;
  }

  /** Model invocations reserved so far — the sample behind a count breach. */
  get modelInvocations(): number {
    return this.invocations;
  }

  tryConsumeModelInvocation(): boolean {
    if (this.latched) return false;

    const max = this.config.maxModelInvocations;
    if (max === undefined) {
      this.invocations++;
      return true;
    }

    const attempt = this.invocations + 1;
    if (attempt > max) {
      // Deliberately does NOT abort the signal. The caller is returning a
      // step failure right now; aborting here would mark the remaining steps
      // "cancelled" and race the rollback that the runner is about to run.
      // The runner's own breach check stops the run one statement later.
      this.latched = {
        kind: 'model-invocations',
        limit: max,
        observed: attempt,
        message:
          `Spell run exceeded its model-invocation ceiling: ${max} allowed, ` +
          `attempt ${attempt} denied before spawning. Raise ` +
          `\`spells.budget.*.maxModelInvocations\` in moflo.yaml (or the spell's ` +
          `own \`budget\` block) if this run legitimately needs more.`,
      };
      return false;
    }

    this.invocations = attempt;
    return true;
  }

  /**
   * Latch a wall-clock breach if the deadline has passed.
   *
   * The deadline timer normally does this on its own. The runner also calls it
   * between steps so enforcement does not depend on timer delivery — under a
   * fake clock, or when the event loop was blocked by a long synchronous step,
   * the timer may not have run yet.
   */
  checkWallClock(): void {
    if (this.latched || this.deadlineAt === null) return;
    if (this.now() < this.deadlineAt) return;
    this.breachWallClock();
  }

  /** Release the deadline timer and the parent-signal listener. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.parentSignal && this.parentAbortListener) {
      this.parentSignal.removeEventListener('abort', this.parentAbortListener);
      this.parentAbortListener = null;
    }
  }

  private breachWallClock(): void {
    if (this.latched) return;
    const limit = this.config.maxWallClockMs;
    if (limit === undefined) return;

    const observed = this.now() - this.startedAt;
    this.latched = {
      kind: 'wall-clock',
      limit,
      observed,
      message:
        `Spell run exceeded its wall-clock ceiling: ${limit}ms allowed, ` +
        `${observed}ms elapsed. The run was aborted. Raise ` +
        `\`spells.budget.*.maxWallClockMs\` in moflo.yaml (or the spell's own ` +
        `\`budget\` block) if this run legitimately takes longer.`,
    };
    // Unlike the invocation ceiling, there is no in-flight caller to hand a
    // failure to — the only way to stop a long-running step is to abort it.
    this.controller.abort();
  }
}

/**
 * Build a budget for one run, or return null when nothing is configured.
 *
 * Returning null rather than a permissive budget is what makes the feature
 * opt-in at the code level and not just the config level: with no ceilings the
 * runner never constructs a budget, never swaps the abort signal, and never
 * puts anything on the casting context.
 */
export function createRunBudget(
  config: SpellBudgetConfig | undefined,
  options: RunBudgetOptions = {},
): SpellRunBudget | null {
  if (!hasBudgetLimit(config)) return null;
  return new SpellRunBudget(config as SpellBudgetConfig, options);
}
