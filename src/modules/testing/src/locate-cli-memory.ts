/**
 * Walk up from this file's location to find cli's compiled memory module.
 *
 * Memory was inlined into the cli package by issue #598 (epic #586). The bare
 * `@moflo/memory` specifier no longer resolves, but the source still ships at
 * `<moflo-root>/src/modules/cli/dist/src/memory/index.js`.
 *
 * Layout-invariant — walks parent directories looking for the stable marker so
 * it works in dev source, built output, and installed consumer trees. Returns
 * null when the file isn't found (caller should degrade to mock / no-op).
 *
 * Disappears once the workspace-collapse epic finishes — at that point all
 * cross-module dynamic imports become local relative imports.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_WALK_DEPTH = 12;
const REL = join('src', 'modules', 'cli', 'dist', 'src', 'memory', 'index.js');

let cached: string | null | undefined;

export function locateCliMemory(): string | null {
  if (cached !== undefined) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const candidate = join(dir, REL);
    if (existsSync(candidate)) {
      cached = pathToFileURL(candidate).href;
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = null;
  return null;
}

/**
 * Locate + dynamic-import the inlined memory module. Throws if it can't be
 * found on disk. Mirrors `importCliShared` so regression-suite callers stay
 * one-liners and error messages stay consistent.
 */
export async function importCliMemory(): Promise<any> {
  const url = locateCliMemory();
  if (!url) throw new Error('cli memory module not found on disk');
  return import(url);
}

/** Test-only: reset the cache between tests that mutate the filesystem. */
export function _resetLocateCliMemoryCacheForTest(): void {
  cached = undefined;
}
