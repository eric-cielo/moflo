/**
 * Sync re-export of `@moflo/shared/utils/atomic-file-write` (#564).
 *
 * The canonical helper lives in `@moflo/shared` so that `embeddings`, `memory`,
 * and `shared` itself can share it. Bare `import from '@moflo/shared'` does NOT
 * resolve at runtime in this monorepo because cross-package symlinks aren't
 * shipped in the published `moflo` tarball. Instead we reuse the existing
 * walk-up resolver (`locateMofloModulePath`) to find the compiled JS file on
 * disk and `createRequire` to sync-load it — the same pattern `doctor.ts` uses
 * to reach `@moflo/neural`.
 *
 * The shared module is loaded lazily on first call rather than at import time
 * so tests that mock `./moflo-require.js` (for other, unrelated reasons)
 * aren't forced to re-export `locateMofloModulePath`. Keeping the load lazy
 * also means cli modules that import this shim but never actually call the
 * helper don't pay the walk-up cost.
 *
 * @module @moflo/cli/services/atomic-file-write
 */

import { createRequire } from 'node:module';
import { locateMofloModulePath } from './moflo-require.js';

// Type-only import — erased at runtime. Pulls types via TS project reference
// to `@moflo/shared`, so callers get full type inference from the canonical
// source without needing a runtime dependency edge.
import type {
  atomicWriteFileSync as AtomicWriteFileSyncFn,
  AtomicWriteFs as AtomicWriteFsType,
} from '../../../shared/src/utils/atomic-file-write.js';

export type AtomicWriteFs = AtomicWriteFsType;

let cached: typeof AtomicWriteFileSyncFn | null = null;

function loadShared(): typeof AtomicWriteFileSyncFn {
  if (cached) return cached;
  const sharedPath = locateMofloModulePath('shared', 'dist/utils/atomic-file-write.js');
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
