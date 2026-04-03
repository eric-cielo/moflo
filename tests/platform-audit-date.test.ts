import { describe, it, expect } from 'vitest';
import { PLATFORM_AUDIT_DATE } from '../src/packages/shared/src/utils/platform.js';

describe('PLATFORM_AUDIT_DATE', () => {
  it('should be exported with the expected value', () => {
    expect(PLATFORM_AUDIT_DATE).toBe('2026-04-01');
  });
});
