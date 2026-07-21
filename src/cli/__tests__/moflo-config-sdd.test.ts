/**
 * Tests for the `sdd.specs_dir` config field added by issue #1294.
 *
 * Covers: default `.moflo/specs` when absent, honoring a configured value,
 * camelCase alias, empty-string fallback, and isolation from `sdd.default`.
 * The seed feeds `specsRoot()` (src/cli/sdd/artifacts.ts), which resolves the
 * value cross-platform. Default keeps specs local + gitignored; a tracked path
 * makes them reviewable in PRs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMofloConfig } from '../config/moflo-config.js';

describe('moflo-config: sdd.specs_dir', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-sdd-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to .moflo/specs when no config file exists', () => {
    expect(loadMofloConfig(root).sdd.specs_dir).toBe('.moflo/specs');
  });

  it('defaults to .moflo/specs when the sdd section omits specs_dir', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  default: true\n');
    const config = loadMofloConfig(root);
    expect(config.sdd.specs_dir).toBe('.moflo/specs');
    expect(config.sdd.default).toBe(true); // not disturbed
  });

  it('honors a configured tracked path', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  specs_dir: docs/specs\n');
    expect(loadMofloConfig(root).sdd.specs_dir).toBe('docs/specs');
  });

  it('accepts the camelCase specsDir alias', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  specsDir: .specs\n');
    expect(loadMofloConfig(root).sdd.specs_dir).toBe('.specs');
  });

  it('falls back to the default on an empty string', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  specs_dir: ""\n');
    expect(loadMofloConfig(root).sdd.specs_dir).toBe('.moflo/specs');
  });

  it('does not disturb other sections', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      ['sdd:', '  default: true', '  specs_dir: docs/specs', 'merge:', '  auto: true', ''].join('\n'),
    );
    const config = loadMofloConfig(root);
    expect(config.sdd.default).toBe(true);
    expect(config.sdd.specs_dir).toBe('docs/specs');
    expect(config.merge.auto).toBe(true);
  });
});

describe('moflo-config: sdd.human_checkpoints + embed_in_pr (#1297)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'moflo-config-sdd2-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('defaults human_checkpoints=false, embed_in_pr=true', () => {
    const cfg = loadMofloConfig(root).sdd;
    expect(cfg.human_checkpoints).toBe(false);
    expect(cfg.embed_in_pr).toBe(true);
  });

  it('honors explicit snake_case values', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  human_checkpoints: true\n  embed_in_pr: false\n');
    const cfg = loadMofloConfig(root).sdd;
    expect(cfg.human_checkpoints).toBe(true);
    expect(cfg.embed_in_pr).toBe(false);
  });

  it('accepts camelCase aliases', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  humanCheckpoints: true\n  embedInPr: false\n');
    const cfg = loadMofloConfig(root).sdd;
    expect(cfg.human_checkpoints).toBe(true);
    expect(cfg.embed_in_pr).toBe(false);
  });

  it('leaves specs_dir + default intact', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'sdd:\n  default: true\n  human_checkpoints: true\n');
    const cfg = loadMofloConfig(root).sdd;
    expect(cfg.default).toBe(true);
    expect(cfg.specs_dir).toBe('.moflo/specs');
    expect(cfg.human_checkpoints).toBe(true);
    expect(cfg.embed_in_pr).toBe(true);
  });
});
