/**
 * moflo-require — Resolve moflo's own dependencies from its own node_modules.
 *
 * When moflo runs via `npx` in a consuming project, bare `await import('sql.js')`
 * resolves from the *consuming project's* node_modules, not moflo's.  Since moflo
 * ships these dependencies itself, we always resolve from moflo's own context first
 * and only fall back to a bare import as a last resort.
 *
 * Usage:
 *   import { mofloImport } from '../services/moflo-require.js';
 *   const sqlJs = await mofloImport('sql.js');
 *   const embeddings = await mofloImport('@moflo/embeddings');
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

// createRequire anchored to this file — resolves from moflo's own node_modules
const mofloRequire = createRequire(fileURLToPath(import.meta.url));

/**
 * Dynamically import a package, resolving from moflo's own node_modules first.
 * Falls back to bare import only if local resolution fails (e.g. monorepo hoisting).
 *
 * On Windows, `createRequire.resolve()` returns a native path (C:\...) which
 * `import()` rejects — it requires a file:// URL.  We convert via pathToFileURL.
 *
 * @param specifier       Package specifier, e.g. 'sql.js' or '@moflo/embeddings'
 * @param expectedExports Optional list of named exports the caller relies on.
 *                        When provided, the module is validated after load; if any
 *                        named export is missing, a warning is emitted and null
 *                        is returned (issue #482 — prevent silent shape mismatches).
 * @returns               The imported module, or null if not available / shape mismatch
 */
export async function mofloImport(
  specifier: string,
  expectedExports?: readonly string[],
): Promise<any> {
  let mod: any;
  try {
    const resolved = mofloRequire.resolve(specifier);
    // Convert native path → file:// URL (required on Windows for ESM import())
    const url = pathToFileURL(resolved).href;
    mod = await import(url);
  } catch {
    // Local resolution failed — try bare import as last resort
    try {
      mod = await import(specifier);
    } catch {
      return null;
    }
  }

  if (expectedExports && expectedExports.length > 0) {
    // `in` distinguishes missing-export from present-but-undefined re-exports.
    const missing = expectedExports.filter(
      k => !(k in mod) || mod[k] === undefined
    );
    if (missing.length > 0) {
      console.warn(
        `[mofloImport] '${specifier}' missing expected exports: ${missing.join(', ')}`
      );
      return null;
    }
  }

  return mod;
}

/**
 * Like mofloImport but throws if the package is not found (for required deps).
 */
export async function mofloImportRequired(specifier: string): Promise<any> {
  const mod = await mofloImport(specifier);
  if (mod === null) {
    throw new Error(`Required dependency '${specifier}' not found in moflo's node_modules`);
  }
  return mod;
}

/**
 * Resolve a package path without importing (useful for WASM file paths etc).
 * Returns the resolved path, or null if not found.
 */
export function mofloResolve(specifier: string): string | null {
  try {
    return mofloRequire.resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Internal moflo packages whose built artifacts can be resolved via walk-up.
 * Union rather than free string: catches typos at the call site and documents
 * the intended consumers.
 */
export type MofloInternalPackage =
  | 'memory'
  | 'swarm'
  | 'hooks'
  | 'embeddings'
  | 'guidance'
  | 'neural'
  | 'security'
  | 'shared'
  | 'spells'
  | 'plugins';

/**
 * Locate a built artifact inside `src/modules/<pkg>/dist/<relFromDist>` by
 * walking up from this file's directory until the path resolves. Layout- and
 * platform-invariant across:
 *   - dev source (<caller>/src/...)
 *   - built output (<caller>/dist/src/...)
 *   - installed package (node_modules/moflo/src/modules/<caller>/dist/src/...)
 *   - Windows and POSIX (`path.join`/`dirname` are platform-aware,
 *     `pathToFileURL` emits valid `file://` URLs on both)
 *
 * Consolidates the walk-up logic so callers can't construct brittle
 * `../../../../` strings that silently point at the wrong package when the
 * source/dist depth changes (see feedback_no_fixed_depth_paths).
 *
 * Returns a `file://` URL suitable for ESM `import()`, or `null` if the
 * artifact isn't on disk (package not built / missing from install).
 */
const moduleDistUrlCache = new Map<string, string | null>();

// Walk cap: the deepest real install is roughly
// `<consumer>/node_modules/moflo/src/modules/<pkg>/dist/src/<...>` ≈ 8 hops up
// to the moflo root. 12 gives comfortable headroom for worktree and monorepo
// layouts without risking an unbounded loop at filesystem root.
const MAX_WALK_DEPTH = 12;

export function locateMofloModuleDist(pkg: MofloInternalPackage, relFromDist: string): string | null {
  const cacheKey = `${pkg}::${relFromDist}`;
  const cached = moduleDistUrlCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join('src', 'modules', pkg, 'dist', relFromDist);

  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) {
      const url = pathToFileURL(candidate).href;
      moduleDistUrlCache.set(cacheKey, url);
      return url;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  moduleDistUrlCache.set(cacheKey, null);
  return null;
}

function locateMofloMemoryDist(): string | null {
  return locateMofloModuleDist('memory', 'index.js');
}

/**
 * Import `@moflo/memory` from within a moflo source module.
 *
 * The root `moflo` package ships @moflo/memory as a source folder rather than
 * a declared dependency, so `mofloImport('@moflo/memory')` fails in consumer
 * installs (node_modules/@moflo/memory/ doesn't exist). Fall back to a
 * layout-invariant walk-up that finds `src/modules/memory/dist/index.js`
 * regardless of whether the caller is running source, built, or installed.
 *
 * Returns null when memory isn't available — callers must handle that.
 */
export async function importMofloMemory(): Promise<any | null> {
  const viaRequire = await mofloImport('@moflo/memory');
  if (viaRequire) return viaRequire;
  const url = locateMofloMemoryDist();
  if (!url) return null;
  try {
    return await import(url);
  } catch {
    return null;
  }
}

// Test-only: reset the cache between unit tests that mutate the filesystem.
export function _resetMofloMemoryCacheForTest(): void {
  moduleDistUrlCache.clear();
}
