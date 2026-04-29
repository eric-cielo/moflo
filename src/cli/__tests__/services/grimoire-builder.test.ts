/**
 * Grimoire Builder Tests
 *
 * Issue #755 — `flo spell grimoire list` was empty out of the box because the
 * shipped definitions directory didn't exist. The two epic spells now live at
 * `src/cli/spells/definitions/` (the canonical shipped path resolved by
 * `resolveSpellDirs`) and are published via the package.json files entry of
 * the same name. This test pins the contract: a fresh resolution against the
 * repo root must find the directory and surface both shipped spells.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSpellDirs } from '../../services/grimoire-builder.js';

describe('resolveSpellDirs', () => {
  it('resolves shippedDir to the canonical src/cli/spells/definitions path', () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const { shippedDir } = resolveSpellDirs(repoRoot);

    expect(shippedDir).toBeTruthy();
    expect(shippedDir.replace(/\\/g, '/')).toMatch(/src\/cli\/spells\/definitions$/);
    expect(existsSync(shippedDir)).toBe(true);
  });

  it('shipped definitions directory contains both epic spells (#755)', () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const { shippedDir } = resolveSpellDirs(repoRoot);

    const files = readdirSync(shippedDir).filter(f => f.endsWith('.yaml'));
    expect(files).toContain('epic-single-branch.yaml');
    expect(files).toContain('epic-auto-merge.yaml');
  });
});
