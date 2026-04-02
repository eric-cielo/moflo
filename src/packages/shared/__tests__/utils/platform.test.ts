import { describe, it, expect } from 'vitest';
import { PLATFORM_AUDIT_DATE } from '../../src/utils/platform.js';

describe('platform constants', () => {
  it('exports PLATFORM_AUDIT_DATE with the expected value', () => {
    expect(PLATFORM_AUDIT_DATE).toBe('2026-04-01');
  });
});
