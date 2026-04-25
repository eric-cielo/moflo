/**
 * Walk up to find cli's compiled memory module.
 *
 * Mirrors `locate-cli-embeddings.ts`. Both helpers exist because hooks loads
 * cli artifacts dynamically — a project-reference would create a cycle
 * (cli already references hooks) and bare `@moflo/memory` no longer resolves
 * after the workspace-collapse epic moved memory into cli (#586 / story #598).
 *
 * Returns null when the file isn't found; caller should degrade gracefully.
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

/** Test-only: reset the cache between tests that mutate the filesystem. */
export function _resetLocateCliMemoryCacheForTest(): void {
  cached = undefined;
}
