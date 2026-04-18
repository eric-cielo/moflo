/**
 * Tests for the `spells` config section added by issue #442.
 *
 * Covers: default when absent, explicit userDirs, shippedDir override,
 * empty-array treated as absent, and that defaults are preserved across
 * all other sections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMofloConfig } from '../src/config/moflo-config.js';

describe('moflo-config: spells section', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-spells-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to [.claude/spells] when no config file exists', () => {
    const config = loadMofloConfig(root);
    expect(config.spells.userDirs).toEqual(['.claude/spells']);
    expect(config.spells.shippedDir).toBeUndefined();
  });

  it('defaults to [.claude/spells] when moflo.yaml has no spells section', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'project:\n  name: test\n');
    const config = loadMofloConfig(root);
    expect(config.spells.userDirs).toEqual(['.claude/spells']);
  });

  it('reads explicit userDirs array from moflo.yaml', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      'spells:\n  userDirs:\n    - my/custom/path\n    - another/path\n',
    );
    const config = loadMofloConfig(root);
    expect(config.spells.userDirs).toEqual(['my/custom/path', 'another/path']);
  });

  it('reads shippedDir override from moflo.yaml', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      'spells:\n  shippedDir: fixtures/shipped\n',
    );
    const config = loadMofloConfig(root);
    expect(config.spells.shippedDir).toBe('fixtures/shipped');
  });

  it('falls back to default when userDirs is an empty array', async () => {
    // Empty array is treated the same as absent — prevents a consumer from
    // accidentally disabling all user-spell discovery by writing `userDirs: []`.
    await writeFile(join(root, 'moflo.yaml'), 'spells:\n  userDirs: []\n');
    const config = loadMofloConfig(root);
    expect(config.spells.userDirs).toEqual(['.claude/spells']);
  });

  it('coerces non-string entries to strings', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      'spells:\n  userDirs:\n    - valid/path\n    - 42\n',
    );
    const config = loadMofloConfig(root);
    expect(config.spells.userDirs).toEqual(['valid/path', '42']);
  });

  it('does not disturb other config sections', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      'spells:\n  userDirs:\n    - custom/\nepic:\n  default_strategy: auto-merge\n',
    );
    const config = loadMofloConfig(root);
    expect(config.spells.userDirs).toEqual(['custom/']);
    expect(config.epic.default_strategy).toBe('auto-merge');
  });
});
