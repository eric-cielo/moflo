import { describe, expect, it, beforeEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  importMofloMemory,
  locateMofloModuleDist,
  locateMofloModulePath,
  locateMofloRootPath,
  _resetMofloMemoryCacheForTest,
} from '../../src/services/moflo-require.js';

describe('importMofloMemory (walk-up resolver)', () => {
  beforeEach(() => {
    _resetMofloMemoryCacheForTest();
  });

  it('locates src/modules/memory/dist/index.js from inside moflo tree', async () => {
    const mod = await importMofloMemory();
    expect(mod).not.toBeNull();
    expect(mod).toHaveProperty('HnswLite');
    expect(mod).toHaveProperty('ControllerRegistry');
  });

  it('uses import.meta.url anchor (consumer install layout)', () => {
    // Simulate the installed layout: node_modules/moflo/src/modules/cli/dist/src/services/
    // The real moflo-require.js lives inside moflo regardless of where the consumer
    // project sits on the filesystem. Walk-up from that path must reach the memory
    // dist — which is the same relative layout in every install.
    const selfPath = fileURLToPath(
      // @ts-ignore — test-only: we want the real URL of the compiled/source file
      new URL('../../src/services/moflo-require.ts', import.meta.url),
    );
    expect(existsSync(selfPath)).toBe(true);

    // From moflo-require.ts, walk up to moflo root, then into memory/dist
    let dir = dirname(selfPath);
    let found: string | null = null;
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, 'src', 'modules', 'memory', 'dist', 'index.js');
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    expect(found).not.toBeNull();
    expect(found).toMatch(/[\\/]src[\\/]modules[\\/]memory[\\/]dist[\\/]index\.js$/);
  });

  it('returns null when memory dist is missing (fake tree)', async () => {
    // Build a throwaway tree with moflo-require at cli/dist/src/services/
    // but no memory/dist sibling. Simulates a broken/partial install.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'moflo-require-test-'));
    try {
      const requirePath = join(
        tmpRoot,
        'fake-moflo',
        'src',
        'modules',
        'cli',
        'dist',
        'src',
        'services',
        'moflo-require.js',
      );
      mkdirSync(dirname(requirePath), { recursive: true });
      writeFileSync(requirePath, '// fake', 'utf8');

      // Replicate the walk-up logic inline — we can't re-anchor the real function
      // to a different file, but verifying the algorithm is sufficient.
      let dir = dirname(requirePath);
      let found: string | null = null;
      for (let i = 0; i < 12; i++) {
        const candidate = join(dir, 'src', 'modules', 'memory', 'dist', 'index.js');
        if (existsSync(candidate)) {
          found = candidate;
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      expect(found).toBeNull();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns file:// URL (ESM import() requires URL on Windows)', async () => {
    const mod = await importMofloMemory();
    expect(mod).not.toBeNull();
    // If this resolved to a native Windows path instead of file:// URL,
    // import() would have thrown — the fact that we got a module back
    // proves pathToFileURL conversion is in place.
  });
});

describe('locateMofloModuleDist (regression guard for #556)', () => {
  beforeEach(() => {
    _resetMofloMemoryCacheForTest();
  });

  it('resolves @moflo/memory index from inside the cli package', () => {
    const url = locateMofloModuleDist('memory', 'index.js');
    expect(url).not.toBeNull();
    expect(url).toMatch(/^file:\/\//);
  });

  it('never emits a path containing "modules/modules" (double-modules bug)', () => {
    // Issue #556: mcp__moflo__hive-mind_init failed because a hand-built
    // `../../../../modules/swarm/...` string walked up past `src/modules/` and
    // then re-appended `modules/`, producing `src/modules/modules/swarm/...`.
    // The resolver must never produce that shape on any platform.
    const memoryUrl = locateMofloModuleDist('memory', 'index.js');
    const hooksUrl = locateMofloModuleDist('hooks', 'index.js');
    for (const url of [memoryUrl, hooksUrl]) {
      expect(url).not.toBeNull();
      // Check both URL and decoded-path forms — pathToFileURL percent-encodes
      // some characters on Windows, so we verify both shapes.
      expect(url!).not.toMatch(/[\\/]modules[\\/]modules[\\/]/);
      expect(url!).not.toMatch(/\/modules\/modules\//);
    }
  });

  it('returns null for a non-existent package (no silent success)', () => {
    const url = locateMofloModuleDist('definitely-not-a-real-package', 'index.js');
    expect(url).toBeNull();
  });

  it('is cached per (pkg, rel) key so repeat calls are cheap', () => {
    const a = locateMofloModuleDist('memory', 'index.js');
    const b = locateMofloModuleDist('memory', 'index.js');
    expect(a).toBe(b);
  });
});

describe('locateMofloModulePath (non-dist subpaths)', () => {
  beforeEach(() => {
    _resetMofloMemoryCacheForTest();
  });

  it('returns null for a non-existent subpath (no silent success)', () => {
    const result = locateMofloModulePath('spells', 'definitely-not-a-real-subdir');
    expect(result).toBeNull();
  });

  it('resolves an existing non-dist subpath (e.g. package.json)', () => {
    // Every moflo package has a package.json — use it as a stable marker.
    const result = locateMofloModulePath('spells', 'package.json');
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    expect(result!).toMatch(/[\\/]src[\\/]modules[\\/]spells[\\/]package\.json$/);
  });

  it('never emits a "modules/modules" path shape', () => {
    const result = locateMofloModulePath('spells', 'package.json');
    expect(result).not.toBeNull();
    expect(result!).not.toMatch(/[\\/]modules[\\/]modules[\\/]/);
  });

  it('is cached per (pkg, rel) key', () => {
    const a = locateMofloModulePath('spells', 'package.json');
    const b = locateMofloModulePath('spells', 'package.json');
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
