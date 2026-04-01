import { describe, it, expect } from 'vitest';
import { PLATFORM_AUDIT_DATE, IS_WINDOWS, NULL_DEVICE, getShell, escapeShellArg } from '../../src/utils/platform.js';

describe('platform utilities', () => {
  it('exports PLATFORM_AUDIT_DATE as a date string', () => {
    expect(PLATFORM_AUDIT_DATE).toBe('2026-04-01');
    expect(typeof PLATFORM_AUDIT_DATE).toBe('string');
  });

  it('exports IS_WINDOWS as a boolean', () => {
    expect(typeof IS_WINDOWS).toBe('boolean');
  });

  it('exports NULL_DEVICE as a string', () => {
    expect(typeof NULL_DEVICE).toBe('string');
    expect(NULL_DEVICE).toBeTruthy();
  });

  it('getShell returns a string', () => {
    expect(typeof getShell()).toBe('string');
  });

  it('escapeShellArg wraps and escapes', () => {
    const result = escapeShellArg('hello');
    expect(result).toContain('hello');
    expect(typeof result).toBe('string');
  });
});
