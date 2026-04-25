/**
 * Sync re-export of `@moflo/shared/utils/atomic-file-write` (#564).
 *
 * Mirrors the pattern used by the cli shim at
 * `@moflo/cli/services/atomic-file-write`: lazy-load the canonical helper via
 * a filesystem walk-up, because bare `@moflo/shared` doesn't resolve in the
 * published moflo tree (no cross-package symlinks) and fixed-depth relative
 * paths into `shared/dist/` leak shared's build layout into embeddings source
 * — exactly the anti-pattern `feedback_no_fixed_depth_paths` warns about.
 *
 * The walk-up is inlined here rather than imported from a shared resolver
 * because the resolver itself would need cross-package resolution to reach.
 *
 * @module cli/embeddings/utils/atomic-file-write
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type {
  atomicWriteFileSync as AtomicWriteFileSyncFn,
  AtomicWriteFs as AtomicWriteFsType,
} from '../../../../shared/src/utils/atomic-file-write.js';

export type AtomicWriteFs = AtomicWriteFsType;

const MAX_WALK_DEPTH = 12;

function locateSharedAtomicWriteJs(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join('src', 'modules', 'shared', 'dist', 'utils', 'atomic-file-write.js');
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: typeof AtomicWriteFileSyncFn | null = null;

function loadShared(): typeof AtomicWriteFileSyncFn {
  if (cached) return cached;
  const sharedPath = locateSharedAtomicWriteJs();
  if (!sharedPath) {
    throw new Error(
      '@moflo/shared utils/atomic-file-write.js not found on disk. ' +
        'Build @moflo/shared first (`npm run build` or `tsc -b`).',
    );
  }
  const req = createRequire(import.meta.url);
  const shared = req(sharedPath) as { atomicWriteFileSync: typeof AtomicWriteFileSyncFn };
  cached = shared.atomicWriteFileSync;
  return cached;
}

export const atomicWriteFileSync: typeof AtomicWriteFileSyncFn = (
  targetPath,
  data,
  fs,
) => loadShared()(targetPath, data, fs);
