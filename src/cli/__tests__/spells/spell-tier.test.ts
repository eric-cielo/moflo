/**
 * Tests for inferSpellTier (#1003).
 *
 * Used by the post-cast arg-writeback offer to skip mutating shipped YAMLs.
 */

import { describe, it, expect } from 'vitest';
import { inferSpellTier } from '../../spells/core/spell-tier.js';

describe('inferSpellTier', () => {
  it.each([
    ['/home/me/proj/node_modules/moflo/dist/src/cli/spells/definitions/oap.yaml', 'shipped'],
    ['C:\\dev\\proj\\node_modules\\moflo\\dist\\src\\cli\\spells\\definitions\\oap.yaml', 'shipped'],
    ['/home/me/proj/node_modules/@moflo/cli/spells/definitions/oap.yaml', 'shipped'],
    ['/home/me/moflo/src/cli/spells/definitions/epic-single-branch.yaml', 'shipped'],
    ['/home/me/proj/.claude/spells/oap.yaml', 'user'],
    ['/home/me/proj/spells/dev/oap.yaml', 'user'],
    ['./spells/local.yaml', 'user'],
  ])('%s → %s', (path, expected) => {
    expect(inferSpellTier(path)).toBe(expected);
  });

  it('returns user when no source path is known (e.g. inline content)', () => {
    expect(inferSpellTier(undefined)).toBe('user');
  });
});
