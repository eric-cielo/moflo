/**
 * Story #285 (epic #287) — verify the ENGINE_VERSION constant.
 * Trivial workflow-test story exercising the /flo --sdd flow end-to-end.
 */

import { describe, it, expect } from 'vitest';
import { ENGINE_VERSION } from '../../spells/core/runner.js';

describe('ENGINE_VERSION (#285)', () => {
  it('is exported and equals the string "1.0.0"', () => {
    expect(ENGINE_VERSION).toBe('1.0.0');
    expect(typeof ENGINE_VERSION).toBe('string');
  });
});
