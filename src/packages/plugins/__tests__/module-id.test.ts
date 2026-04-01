import { describe, it, expect } from 'vitest';
import { MODULE_ID } from '../src/index.js';

describe('MODULE_ID', () => {
  it('exports the package identifier', () => {
    expect(MODULE_ID).toBe('@claude-flow/plugins');
  });
});
