/**
 * Tests for the `merge` config section added by issue #1285.
 *
 * Covers: default false when absent, default false when the section is absent,
 * explicit true/false round-trips, partial/other-section isolation. Mirrors the
 * shape of moflo-config-scheduler.test.ts. The seed feeds the `/flo` skill's
 * `mergeMode` (auto-merge the PR at the end of a full run) — default false so
 * existing consumers keep the "stop at PR opened" behavior until they opt in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMofloConfig } from '../config/moflo-config.js';

describe('moflo-config: merge section', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-merge-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to auto:false when no config file exists', () => {
    const config = loadMofloConfig(root);
    expect(config.merge).toEqual({ auto: false });
  });

  it('defaults to auto:false when moflo.yaml has no merge section', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'project:\n  name: test\n');
    const config = loadMofloConfig(root);
    expect(config.merge.auto).toBe(false);
  });

  it('honors merge.auto: true', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'merge:\n  auto: true\n');
    const config = loadMofloConfig(root);
    expect(config.merge.auto).toBe(true);
  });

  it('honors merge.auto: false explicitly', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'merge:\n  auto: false\n');
    const config = loadMofloConfig(root);
    expect(config.merge.auto).toBe(false);
  });

  it('does not disturb other config sections', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      ['merge:', '  auto: true', 'sdd:', '  default: true', ''].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.merge.auto).toBe(true);
    expect(config.sdd.default).toBe(true);
  });
});
