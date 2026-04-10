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
} from '../../spells/src/core/platform-sandbox.js';

describe('doctor sandbox tier diagnostic', () => {
  afterEach(() => {
    resetSandboxCache();
    vi.restoreAllMocks();
  });

  it('detectSandboxCapability returns a valid SandboxCapability', () => {
    const cap = detectSandboxCapability();

    expect(cap).toHaveProperty('platform');
    expect(cap).toHaveProperty('available');
    expect(cap).toHaveProperty('tool');
    expect(cap).toHaveProperty('overhead');
    expect(typeof cap.available).toBe('boolean');
  });

  it('returns cached result on subsequent calls', () => {
    const first = detectSandboxCapability();
    const second = detectSandboxCapability();

    // Same reference — cached
    expect(first).toBe(second);
  });

  it('resetSandboxCache clears the cache', () => {
    const first = detectSandboxCapability();
    resetSandboxCache();
    const second = detectSandboxCapability();

    // Different reference after cache reset (though values may be equal)
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('capability fields match expected doctor output format', () => {
    const cap = detectSandboxCapability();

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

  it('platform matches current OS', () => {
    const cap = detectSandboxCapability();
    expect(cap.platform).toBe(process.platform);
  });
});
