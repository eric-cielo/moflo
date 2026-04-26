/**
 * Tests for the `scheduler` config section added by issue #446.
 *
 * Covers: defaults when absent, full override, partial override, rejects
 * invalid values (non-positive, non-numeric), camelCase and snake_case
 * key acceptance, and that enabled=false is honored verbatim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMofloConfig } from '../config/moflo-config.js';

const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 60_000,
  maxConcurrent: 2,
  catchUpWindowMs: 3_600_000,
};

describe('moflo-config: scheduler section', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-scheduler-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('defaults match the DEFAULT_* constants from scheduler.ts when no config file exists', () => {
    const config = loadMofloConfig(root);
    expect(config.scheduler).toEqual(DEFAULTS);
  });

  it('defaults apply when moflo.yaml has no scheduler section', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'project:\n  name: test\n');
    const config = loadMofloConfig(root);
    expect(config.scheduler).toEqual(DEFAULTS);
  });

  it('reads all four keys when fully specified', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      [
        'scheduler:',
        '  enabled: false',
        '  pollIntervalMs: 30000',
        '  maxConcurrent: 4',
        '  catchUpWindowMs: 7200000',
        '',
      ].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.scheduler).toEqual({
      enabled: false,
      pollIntervalMs: 30_000,
      maxConcurrent: 4,
      catchUpWindowMs: 7_200_000,
    });
  });

  it('applies defaults for missing keys (partial override)', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      'scheduler:\n  pollIntervalMs: 10000\n',
    );
    const config = loadMofloConfig(root);
    expect(config.scheduler).toEqual({
      ...DEFAULTS,
      pollIntervalMs: 10_000,
    });
  });

  it('accepts snake_case keys alongside camelCase', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      [
        'scheduler:',
        '  poll_interval_ms: 5000',
        '  max_concurrent: 8',
        '  catch_up_window_ms: 600000',
        '',
      ].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.scheduler.pollIntervalMs).toBe(5000);
    expect(config.scheduler.maxConcurrent).toBe(8);
    expect(config.scheduler.catchUpWindowMs).toBe(600_000);
  });

  it('rejects zero/negative numbers and falls back to defaults', async () => {
    // Zero would break the scheduler's setInterval + concurrency gate, so we
    // reject at config-load time rather than letting the daemon start with
    // a broken poll loop.
    await writeFile(
      join(root, 'moflo.yaml'),
      [
        'scheduler:',
        '  pollIntervalMs: 0',
        '  maxConcurrent: -1',
        '  catchUpWindowMs: 0',
        '',
      ].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.scheduler.pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
    expect(config.scheduler.maxConcurrent).toBe(DEFAULTS.maxConcurrent);
    expect(config.scheduler.catchUpWindowMs).toBe(DEFAULTS.catchUpWindowMs);
  });

  it('rejects non-numeric values and falls back to defaults', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      [
        'scheduler:',
        '  pollIntervalMs: "fast"',
        '  maxConcurrent: true',
        '',
      ].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.scheduler.pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
    expect(config.scheduler.maxConcurrent).toBe(DEFAULTS.maxConcurrent);
  });

  it('honors enabled: false explicitly', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'scheduler:\n  enabled: false\n');
    const config = loadMofloConfig(root);
    expect(config.scheduler.enabled).toBe(false);
    // Other fields still default — disabling scheduler should not clobber
    // the numeric defaults, so re-enabling is a single-line change.
    expect(config.scheduler.pollIntervalMs).toBe(DEFAULTS.pollIntervalMs);
  });

  it('does not disturb other config sections', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      [
        'scheduler:',
        '  enabled: false',
        'epic:',
        '  default_strategy: auto-merge',
        '',
      ].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.scheduler.enabled).toBe(false);
    expect(config.epic.default_strategy).toBe('auto-merge');
  });
});
