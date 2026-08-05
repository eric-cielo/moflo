/**
 * Per-step retry tests (#1336).
 *
 * Two halves: the primitive in isolation, then the seam — a real SpellCaster
 * run where a step actually fails and actually recovers. The absence cases
 * carry as much weight as the presence ones: a step without `retry` must
 * behave exactly as it does today, including running exactly once.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveStepRetry,
  isRetryableFailure,
  computeBackoffMs,
  abortableDelay,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_TOTAL_DELAY_MS,
} from '../../spells/core/step-retry.js';
import { SpellCaster } from '../../spells/core/runner.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import { validateSpellDefinition } from '../../spells/schema/validator.js';
import type { StepCommand, CredentialAccessor, MemoryAccessor } from '../../spells/types/step-command.types.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';

// ============================================================================
// Config resolution
// ============================================================================

describe('resolveStepRetry', () => {
  it('returns undefined for an absent block', () => {
    expect(resolveStepRetry(undefined)).toBeUndefined();
  });

  it('returns undefined for attempts: 1 — a retry that would never retry', () => {
    // Callers rely on this to take the pre-feature code path rather than
    // loop once, so "no retry block" and "a useless retry block" are identical.
    expect(resolveStepRetry({ attempts: 1 })).toBeUndefined();
  });

  it('returns undefined when attempts is missing, zero, or negative', () => {
    expect(resolveStepRetry({ backoffMs: 500 })).toBeUndefined();
    expect(resolveStepRetry({ attempts: 0 })).toBeUndefined();
    expect(resolveStepRetry({ attempts: -2 })).toBeUndefined();
  });

  it('applies defaults for the delay knobs', () => {
    expect(resolveStepRetry({ attempts: 3 })).toEqual({
      attempts: 3,
      backoffMs: DEFAULT_BACKOFF_MS,
      maxDelayMs: DEFAULT_MAX_DELAY_MS,
      maxTotalDelayMs: DEFAULT_MAX_TOTAL_DELAY_MS,
    });
  });

  it('accepts camelCase and snake_case', () => {
    expect(resolveStepRetry({ attempts: 2, backoff_ms: 250 })?.backoffMs).toBe(250);
    expect(resolveStepRetry({ attempts: 2, backoffMs: 250 })?.backoffMs).toBe(250);
  });

  it('floors a fractional attempt count', () => {
    expect(resolveStepRetry({ attempts: 3.7 })?.attempts).toBe(3);
  });
});

// ============================================================================
// Which failures are worth another attempt
// ============================================================================

describe('isRetryableFailure', () => {
  it('retries execution failures and timeouts', () => {
    expect(isRetryableFailure('STEP_EXECUTION_FAILED')).toBe(true);
    expect(isRetryableFailure('STEP_TIMEOUT')).toBe(true);
  });

  it('does NOT retry deterministic failures', () => {
    // These produce the same result on every attempt, so N tries cost N times
    // as much for one outcome — and under #1335 can burn a spend ceiling.
    expect(isRetryableFailure('CAPABILITY_DENIED')).toBe(false);
    expect(isRetryableFailure('STEP_VALIDATION_FAILED')).toBe(false);
    expect(isRetryableFailure('UNKNOWN_STEP_TYPE')).toBe(false);
    expect(isRetryableFailure('MOFLO_LEVEL_DENIED')).toBe(false);
  });

  it('does NOT retry a cancelled step — the run is already tearing down', () => {
    expect(isRetryableFailure('STEP_CANCELLED')).toBe(false);
  });

  it('does not retry an absent error code', () => {
    expect(isRetryableFailure(undefined)).toBe(false);
  });
});

// ============================================================================
// Backoff
// ============================================================================

describe('computeBackoffMs', () => {
  const fixedJitter = { random: () => 0.5 }; // → multiplier exactly 1.0
  const cfg = { attempts: 5, backoffMs: 100, maxDelayMs: 10_000, maxTotalDelayMs: 60_000 };

  it('grows exponentially from the base delay', () => {
    expect(computeBackoffMs(cfg, 1, 0, fixedJitter)).toBe(100);
    expect(computeBackoffMs(cfg, 2, 0, fixedJitter)).toBe(200);
    expect(computeBackoffMs(cfg, 3, 0, fixedJitter)).toBe(400);
  });

  it('caps any single delay at maxDelayMs', () => {
    const capped = { ...cfg, maxDelayMs: 250 };
    expect(computeBackoffMs(capped, 5, 0, fixedJitter)).toBe(250);
  });

  it('never lets the running total exceed maxTotalDelayMs', () => {
    const tight = { ...cfg, maxTotalDelayMs: 150 };
    expect(computeBackoffMs(tight, 1, 0, fixedJitter)).toBe(100);
    expect(computeBackoffMs(tight, 2, 100, fixedJitter)).toBe(50); // not 200
  });

  it('returns 0 once the aggregate budget is spent, so attempts continue without waiting', () => {
    const tight = { ...cfg, maxTotalDelayMs: 100 };
    expect(computeBackoffMs(tight, 2, 100, fixedJitter)).toBe(0);
  });

  it('applies +/-10% jitter so parallel steps do not retry in lockstep', () => {
    const low = computeBackoffMs(cfg, 1, 0, { random: () => 0 });
    const high = computeBackoffMs(cfg, 1, 0, { random: () => 1 });
    expect(low).toBe(90);
    expect(high).toBe(110);
  });
});

describe('abortableDelay', () => {
  it('resolves after the delay', async () => {
    const start = Date.now();
    await abortableDelay(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await abortableDelay(5_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('cuts a long wait short when the signal aborts mid-delay', async () => {
    // This is what makes a wall-clock ceiling breach (#1335) interrupt a
    // backoff rather than be served after it.
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 20);
    await abortableDelay(5_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('resolves immediately for a zero delay', async () => {
    await expect(abortableDelay(0)).resolves.toBeUndefined();
  });
});

// ============================================================================
// End to end through the real runner
// ============================================================================

const credentials: CredentialAccessor = {
  async get() { return undefined; },
  async has() { return false; },
  async store() { /* no-op */ },
};

function memory(): MemoryAccessor {
  return { async read() { return null; }, async write() {}, async search() { return []; } };
}

/** A step that fails `failTimes` times, then succeeds. Counts its calls. */
function flakyStep(failTimes: number): StepCommand & { calls: number } {
  const cmd = {
    calls: 0,
    type: 'flaky',
    description: 'fails a fixed number of times then succeeds',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    async execute() {
      cmd.calls++;
      if (cmd.calls <= failTimes) {
        return { success: false, data: {}, error: 'transient upstream failure' };
      }
      return { success: true, data: { recovered: true } };
    },
    describeOutputs: () => [{ name: 'recovered', type: 'boolean' as const }],
  };
  return cmd;
}

function casterWith(cmd: StepCommand): SpellCaster {
  const registry = new StepCommandRegistry();
  registry.register(cmd, 'built-in');
  return new SpellCaster(registry, credentials, memory());
}

function spellWith(retry?: Record<string, unknown>): SpellDefinition {
  return {
    name: 'retry-spell',
    steps: [{ id: 'flaky', type: 'flaky', config: {}, ...(retry ? { retry } : {}) }],
  } as SpellDefinition;
}

describe('SpellCaster step retry', () => {
  it('completes the run when a step fails transiently then succeeds', async () => {
    const cmd = flakyStep(2);
    const result = await casterWith(cmd).run(
      spellWith({ attempts: 3, backoffMs: 1 }), {},
    );

    expect(result.success).toBe(true);
    expect(cmd.calls).toBe(3);
    expect(result.steps[0].status).toBe('succeeded');
  });

  it('reports the attempt count, so a third-try success is distinguishable', async () => {
    const cmd = flakyStep(2);
    const result = await casterWith(cmd).run(spellWith({ attempts: 3, backoffMs: 1 }), {});
    expect(result.steps[0].attempts).toBe(3);
  });

  it('reports attempts: 1 when a retry-configured step succeeds first try', async () => {
    const cmd = flakyStep(0);
    const result = await casterWith(cmd).run(spellWith({ attempts: 3, backoffMs: 1 }), {});
    expect(result.steps[0].attempts).toBe(1);
    expect(cmd.calls).toBe(1);
  });

  it('fails the run after exhausting attempts, recording how many were spent', async () => {
    const cmd = flakyStep(99);
    const result = await casterWith(cmd).run(spellWith({ attempts: 3, backoffMs: 1 }), {});

    expect(result.success).toBe(false);
    expect(cmd.calls).toBe(3);
    expect(result.steps[0].attempts).toBe(3);
    expect(result.steps[0].status).toBe('failed');
  });

  it('runs a step without a retry block exactly once, with no attempts field', async () => {
    // The no-change guarantee for every existing spell.
    const cmd = flakyStep(99);
    const result = await casterWith(cmd).run(spellWith(), {});

    expect(cmd.calls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.steps[0].attempts).toBeUndefined();
  });

  it('treats attempts: 1 as no retry at all', async () => {
    const cmd = flakyStep(99);
    const result = await casterWith(cmd).run(spellWith({ attempts: 1 }), {});
    expect(cmd.calls).toBe(1);
    expect(result.steps[0].attempts).toBeUndefined();
  });

  it('does not retry a deterministic failure even when retry is configured', async () => {
    // A validation failure will fail identically forever; spending three
    // attempts on it is pure waste.
    const cmd: StepCommand = {
      type: 'flaky',
      description: 'always invalid',
      configSchema: { type: 'object' },
      validate: () => ({ valid: false, errors: [{ path: 'x', message: 'nope' }] }),
      execute: async () => ({ success: true, data: {} }),
      describeOutputs: () => [],
    };
    const spy = vi.spyOn(cmd, 'validate');

    const result = await casterWith(cmd).run(spellWith({ attempts: 5, backoffMs: 1 }), {});

    expect(result.success).toBe(false);
    expect(result.steps[0].errorCode).toBe('STEP_VALIDATION_FAILED');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the run is cancelled mid-backoff', async () => {
    const cmd = flakyStep(99);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const result = await casterWith(cmd).run(
      spellWith({ attempts: 20, backoffMs: 50 }), {}, { signal: controller.signal },
    );

    // Without the abort check it would have burned all 20 attempts.
    expect(cmd.calls).toBeLessThan(20);
    expect(result.success).toBe(false);
  });

  it('bounds total waiting so a scheduled run cannot stall indefinitely', async () => {
    const cmd = flakyStep(99);
    const start = Date.now();

    await casterWith(cmd).run(
      spellWith({ attempts: 6, backoffMs: 1_000, maxTotalDelayMs: 60 }), {},
    );

    // Six attempts at 1s exponential backoff would be ~31s unbounded.
    expect(cmd.calls).toBe(6);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

// ============================================================================
// Definition validation
// ============================================================================

describe('retry block validation', () => {
  function errorsFor(retry: unknown): string[] {
    const def = {
      name: 'v', steps: [{ id: 's1', type: 'bash', config: {}, retry }],
    } as unknown as SpellDefinition;
    return validateSpellDefinition(def).errors.map(e => e.message);
  }

  it('accepts a well-formed block', () => {
    expect(errorsFor({ attempts: 3, backoffMs: 500 })).toEqual([]);
  });

  it('rejects an unknown key rather than silently meaning "no retry"', () => {
    const errors = errorsFor({ attempts: 3, backofMs: 500 });
    expect(errors.some(m => m.includes('unknown retry key "backofMs"'))).toBe(true);
  });

  it('rejects a non-object retry value', () => {
    expect(errorsFor(3).some(m => m.includes('retry must be an object'))).toBe(true);
    expect(errorsFor([]).some(m => m.includes('retry must be an object'))).toBe(true);
  });

  it('requires attempts when a retry block is present', () => {
    expect(errorsFor({ backoffMs: 100 }).some(m => m.includes('retry.attempts is required'))).toBe(true);
  });

  it('rejects non-positive numbers', () => {
    expect(errorsFor({ attempts: 0 }).some(m => m.includes('greater than 0'))).toBe(true);
    expect(errorsFor({ attempts: 3, backoffMs: -1 }).some(m => m.includes('greater than 0'))).toBe(true);
  });

  it('leaves a step with no retry block valid', () => {
    const def = { name: 'v', steps: [{ id: 's1', type: 'bash', config: {} }] } as SpellDefinition;
    expect(validateSpellDefinition(def).valid).toBe(true);
  });
});

// ============================================================================
// Precedence over the credential-refresh path (#1042)
// ============================================================================

describe('retry vs credential refresh', () => {
  /** A step that always fails with an auth-shaped error. */
  function authFailingStep(): StepCommand & { calls: number } {
    const cmd = {
      calls: 0,
      type: 'flaky',
      description: 'always fails with an auth-shaped error',
      configSchema: { type: 'object' },
      validate: () => ({ valid: true, errors: [] }),
      async execute() {
        cmd.calls++;
        return { success: false, data: {}, error: 'HTTP 401 Unauthorized: invalid token' };
      },
      describeOutputs: () => [],
    };
    return cmd;
  }

  it('does not burn retry attempts on an auth-shaped failure', async () => {
    // The credential path (#1042) runs AFTER runStep returns, so without this
    // carve-out a stale token would be retried to exhaustion — with backoff —
    // before the re-prompt that could actually fix it was ever offered.
    const cmd = authFailingStep();
    const result = await casterWith(cmd).run(
      spellWith({ attempts: 5, backoffMs: 1_000 }), {},
    );

    expect(cmd.calls).toBe(1);
    expect(result.success).toBe(false);
  });

  it('still retries a non-auth failure from the same step type', async () => {
    // Guards the carve-out against over-reach: only auth SHAPE is exempt.
    const cmd = flakyStep(1);
    const result = await casterWith(cmd).run(spellWith({ attempts: 3, backoffMs: 1 }), {});

    expect(cmd.calls).toBe(2);
    expect(result.success).toBe(true);
  });
});
