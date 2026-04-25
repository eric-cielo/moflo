/**
 * Timeout Executor Tests
 *
 * Unit tests for timeout and cancellation wrapper extracted from SpellCaster (Issue #182).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeWithTimeout } from '../../src/spells/core/timeout-executor.js';

// ============================================================================
// Helpers
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// executeWithTimeout
// ============================================================================

describe('executeWithTimeout', () => {
  it('should resolve with step result when execution completes before timeout', async () => {
    const result = await executeWithTimeout(
      () => Promise.resolve('done'),
      5000,
    );
    expect(result).toBe('done');
  });

  it('should return timeout error when execution exceeds timeout', async () => {
    vi.useFakeTimers();

    const promise = executeWithTimeout(
      () => new Promise(() => {/* never resolves */}),
      100,
    );

    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow('Step timed out');

    vi.useRealTimers();
  });

  it('should reject with the original error when execution fails before timeout', async () => {
    await expect(
      executeWithTimeout(
        () => Promise.reject(new Error('exec failed')),
        5000,
      ),
    ).rejects.toThrow('exec failed');
  });

  it('should handle abort signal cancellation', async () => {
    const controller = new AbortController();

    const promise = executeWithTimeout(
      () => new Promise(() => {/* never resolves */}),
      60_000,
      controller.signal,
    );

    // Abort immediately
    controller.abort();

    await expect(promise).rejects.toThrow('Step cancelled');
  });

  it('should not reject with cancellation if already resolved', async () => {
    const controller = new AbortController();

    const result = await executeWithTimeout(
      () => Promise.resolve(42),
      5000,
      controller.signal,
    );

    // Aborting after resolution should have no effect
    controller.abort();
    expect(result).toBe(42);
  });

  it('should not reject with timeout if already resolved', async () => {
    vi.useFakeTimers();

    const promise = executeWithTimeout(
      () => Promise.resolve('fast'),
      100,
    );

    // Resolve happens synchronously in microtask, advance timer afterwards
    const result = await promise;
    vi.advanceTimersByTime(200);

    expect(result).toBe('fast');

    vi.useRealTimers();
  });

  it('should clean up timer when execution completes', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await executeWithTimeout(
      () => Promise.resolve('ok'),
      5000,
    );

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('should work with complex result types', async () => {
    const complex = { nested: { value: [1, 2, 3] }, flag: true };

    const result = await executeWithTimeout(
      () => Promise.resolve(complex),
      5000,
    );

    expect(result).toEqual(complex);
  });
});
