/**
 * MODULE_ID constant test
 */

import { describe, it, expect } from 'vitest';
import { MODULE_ID } from '../src/index.js';

describe('MODULE_ID', () => {
  it('should equal @claude-flow/plugins', () => {
    expect(MODULE_ID).toBe('@claude-flow/plugins');
  });
});
