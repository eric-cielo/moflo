/**
 * Doctor Sandbox Tier Check — Tests
 *
 * Tests the sandbox tier diagnostic that reports which OS-level sandbox
 * is available on the current platform.
 *
 * Since checkSandboxTier is defined inside doctor.ts handle(), we test
 * the underlying detection logic it uses (detectSandboxCapability) and
 * verify the formatting contract the doctor check expects.
 *
 * @see https://github.com/eric-cielo/moflo/issues/412
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectSandboxCapability,
  resetSandboxCache,
  type SandboxCapability,
} from '../spells/core/platform-sandbox.js';

// 30s per-test timeout: `resetSandboxCache clears the cache` makes TWO cold
// detection calls back-to-back. On Windows under isolation-batch load each
// call can hit BINARY_EXISTS_TIMEOUT_MS (10s) + DOCKER_DAEMON_TIMEOUT_MS (15s)
// in platform-sandbox.ts, so 15s wasn't enough headroom. 30s is the project
// ceiling for per-test timeouts (feedback_no_test_timeout_bumps).
describe('doctor sandbox tier diagnostic', { timeout: 30_000 }, () => {
  afterEach(() => {
    resetSandboxCache();
    vi.restoreAllMocks();
  });

  it('detectSandboxCapability returns a valid SandboxCapability', async () => {
    const cap = await detectSandboxCapability();

    expect(cap).toHaveProperty('platform');
    expect(cap).toHaveProperty('available');
    expect(cap).toHaveProperty('tool');
    expect(cap).toHaveProperty('overhead');
    expect(typeof cap.available).toBe('boolean');
  });

  it('returns cached result on subsequent calls', async () => {
    const first = await detectSandboxCapability();
    const second = await detectSandboxCapability();

    // Same reference — cached
    expect(first).toBe(second);
  });

  it('resetSandboxCache clears the cache', async () => {
    const first = await detectSandboxCapability();
    resetSandboxCache();
    const second = await detectSandboxCapability();

    // Different reference after cache reset (though values may be equal)
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('capability fields match expected doctor output format', async () => {
    const cap = await detectSandboxCapability();

    // Doctor check formats: `${cap.tool} (${cap.platform})` or `denylist only (${cap.platform})`
    if (cap.available) {
      expect(cap.tool).toBeTruthy();
      expect(cap.overhead).toBeTruthy();
      const formatted = `${cap.tool} (${cap.platform})`;
      expect(formatted).toMatch(/\w+ \(\w+\)/);
    } else {
      expect(cap.tool).toBeNull();
      const formatted = `denylist only (${cap.platform})`;
      expect(formatted).toContain('denylist only');
    }
  });

  it('platform matches current OS', async () => {
    const cap = await detectSandboxCapability();
    expect(cap.platform).toBe(process.platform);
  });
});
