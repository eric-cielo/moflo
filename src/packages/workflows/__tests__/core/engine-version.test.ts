import { describe, it, expect } from 'vitest';
import { ENGINE_VERSION } from '../../src/core/runner.js';

describe('ENGINE_VERSION', () => {
  it('exports a semver string', () => {
    expect(ENGINE_VERSION).toBe('1.0.0');
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
