import { describe, expect, it, beforeEach } from 'vitest';
import { join } from 'path';
import { existsSync } from 'fs';

import {
  locateMofloModuleDist,
  locateMofloModulePath,
  locateMofloRootPath,
  _resetMofloMemoryCacheForTest,
  type MofloInternalPackage,
} from '../../src/services/moflo-require.js';

describe('locateMofloModuleDist (regression guard for #556)', () => {
  beforeEach(() => {
    _resetMofloMemoryCacheForTest();
  });

  it('resolves the cli built index', () => {
    const url = locateMofloModuleDist('cli', 'src/index.js');
    expect(url).not.toBeNull();
    expect(url).toMatch(/^file:\/\//);
  });

  it('never emits a path containing "modules/modules" (double-modules bug)', () => {
    // Issue #556: mcp__moflo__hive-mind_init failed because a hand-built
    // `../../../../modules/swarm/...` string walked up past `src/modules/` and
    // then re-appended `modules/`, producing `src/modules/modules/swarm/...`.
    // The resolver must never produce that shape on any platform.
    const url = locateMofloModuleDist('cli', 'src/index.js');
    expect(url).not.toBeNull();
    // Check both URL and decoded-path forms — pathToFileURL percent-encodes
    // some characters on Windows, so we verify both shapes.
    expect(url!).not.toMatch(/[\\/]modules[\\/]modules[\\/]/);
    expect(url!).not.toMatch(/\/modules\/modules\//);
  });

  it('returns null for a non-existent package (no silent success)', () => {
    const url = locateMofloModuleDist('definitely-not-a-real-package' as MofloInternalPackage, 'index.js');
    expect(url).toBeNull();
  });

  it('is cached per (pkg, rel) key so repeat calls are cheap', () => {
    const a = locateMofloModuleDist('cli', 'src/index.js');
    const b = locateMofloModuleDist('cli', 'src/index.js');
    expect(a).toBe(b);
  });
});

describe('locateMofloModulePath (non-dist subpaths)', () => {
  beforeEach(() => {
    _resetMofloMemoryCacheForTest();
  });

  it('returns null for a non-existent subpath (no silent success)', () => {
    const result = locateMofloModulePath('cli', 'definitely-not-a-real-subdir');
    expect(result).toBeNull();
  });

  it('resolves an existing non-dist subpath (e.g. package.json)', () => {
    // Every remaining moflo package ships a package.json — use it as a stable marker.
    const result = locateMofloModulePath('cli', 'package.json');
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(result!).toMatch(/[\\/]src[\\/]modules[\\/]cli[\\/]package\.json$/);
  });

  it('never emits a "modules/modules" path shape', () => {
    const result = locateMofloModulePath('cli', 'package.json');
    expect(result).not.toBeNull();
    expect(result!).not.toMatch(/[\\/]modules[\\/]modules[\\/]/);
  });

  it('is cached per (pkg, rel) key', () => {
    const a = locateMofloModulePath('cli', 'package.json');
    const b = locateMofloModulePath('cli', 'package.json');
    expect(a).toBe(b);
  });
});

describe('locateMofloRootPath (root-level shipped files — issue #575)', () => {
  beforeEach(() => {
    _resetMofloMemoryCacheForTest();
  });

  it('resolves the moflo root README.md (a stable root-level file)', () => {
    const result = locateMofloRootPath('README.md');
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    // Must end at the actual file, not a `src/modules/<pkg>/README.md` sibling.
    expect(result!).not.toMatch(/[\\/]src[\\/]modules[\\/]/);
  });

  it('returns null for a non-existent root file (no silent success)', () => {
    const result = locateMofloRootPath('definitely-not-a-real-file.txt');
    expect(result).toBeNull();
  });

  it('resolves nested root subpaths (e.g. scripts/clean-dist.mjs)', () => {
    const result = locateMofloRootPath(join('scripts', 'clean-dist.mjs'));
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
  });

  it('is cached per `rel` key', () => {
    const a = locateMofloRootPath('README.md');
    const b = locateMofloRootPath('README.md');
    expect(a).toBe(b);
  });
});

describe('hive-mind-tools path resolution (regression for #556)', () => {
  it('hive-mind_init succeeds (no "Cannot find module" error)', async () => {
    _resetMofloMemoryCacheForTest();
    const { hiveMindTools } = await import('../../src/mcp-tools/hive-mind-tools.js');
    const initTool = hiveMindTools.find(t => t.name === 'hive-mind_init');
    expect(initTool).toBeDefined();

    const result = await initTool!.handler({ topology: 'hierarchical', queenId: 'test-queen' });
    expect(result).toMatchObject({
      success: true,
      topology: 'hierarchical',
      status: 'initialized',
    });

    // Clean up so other tests get a fresh hive
    const shutdownTool = hiveMindTools.find(t => t.name === 'hive-mind_shutdown');
    await shutdownTool!.handler({ graceful: true, force: true });
  });
});
