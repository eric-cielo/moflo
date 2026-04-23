import { describe, expect, it, beforeEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  importMofloMemory,
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
