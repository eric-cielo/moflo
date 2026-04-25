/**
 * Walk up to find cli's compiled embeddings module.
 *
 * Mirrors `src/modules/memory/src/locate-cli-embeddings.ts`. Both copies
 * disappear once the workspace-collapse epic finishes (#586) — until then,
 * each consumer module needs its own walk-up because shared isn't on every
 * module's dependency edge.
 *
 * Returns null when the file isn't found; caller should degrade gracefully.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_WALK_DEPTH = 12;
const REL = join('src', 'modules', 'cli', 'dist', 'src', 'embeddings', 'index.js');

let cached: string | null | undefined;

export function locateCliEmbeddings(): string | null {
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
export function _resetLocateCliEmbeddingsCacheForTest(): void {
  cached = undefined;
}
