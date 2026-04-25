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
 *   const memory = await mofloImport('@moflo/memory');
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
 * @param specifier       Package specifier, e.g. 'sql.js' or '@moflo/memory'
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
 * Import a moflo-bundled package and loud-fail when it isn't resolvable.
 *
 * `mofloImport` returns null silently on resolution failure so probe-style
 * callers (e.g. `mofloImport('sql.js')` for an optional dep) work cleanly.
 * Packages bundled in the moflo tarball must be louder: an unresolved
 * `@moflo/*` means a broken install, and silent skip leaves consumers stuck
 * on stale state with no signal in their logs. Wrap with this helper at any
 * call site where missing == broken.
 *
 * Behaviour:
 *   - Resolves: returns the module.
 *   - Unresolvable + `throwIfMissing: true`: throws Error with the same
 *     message that would otherwise be written to stderr (caller catches
 *     and surfaces a typed response — used by MCP handlers).
 *   - Unresolvable + `throwIfMissing: false` (default): writes one stderr
 *     line and returns null. Caller continues with a fallback path.
 *
 * The stderr line shape is `[<tag>] <specifier> not resolvable — <consequence>`,
 * so log-grep and the consumer-smoke harness's stderr scan both pick it up.
 */
export async function requireMofloOrWarn(
  specifier: string,
  expectedExports: readonly string[],
  opts: { tag: string; consequence: string; throwIfMissing?: boolean },
): Promise<any | null> {
  const mod = await mofloImport(specifier, expectedExports);
  if (mod) return mod;
  const message =
    `[${opts.tag}] ${specifier} not resolvable — ${opts.consequence} ` +
    `Indicates a broken moflo install (missing from tarball or hoisting failure).`;
  if (opts.throwIfMissing) {
    throw new Error(message);
  }
  process.stderr.write(message + '\n');
  return null;
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
  | 'hooks'
  | 'neural'
  | 'security'
  | 'shared'
  | 'plugins'
  | 'cli';

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
// Walk cap: deepest real install is `<consumer>/node_modules/moflo/src/modules/<pkg>/dist/src/<...>`
// ≈ 8 hops to the moflo root. 12 gives headroom for worktree/monorepo layouts.
const MAX_WALK_DEPTH = 12;

// Walk up from this file's dir, returning the first non-null `test(dir)` result.
function walkUpFromSelf<T>(test: (dir: string) => T | null): T | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const hit = test(dir);
    if (hit !== null) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function memoize<T>(cache: Map<string, T | null>, key: string, compute: () => T | null): T | null {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = compute();
  cache.set(key, result);
  return result;
}

const moduleDistUrlCache = new Map<string, string | null>();

export function locateMofloModuleDist(pkg: MofloInternalPackage, relFromDist: string): string | null {
  return memoize(moduleDistUrlCache, `${pkg}::${relFromDist}`, () => {
    const rel = join('src', 'modules', pkg, 'dist', relFromDist);
    return walkUpFromSelf(dir => {
      const candidate = join(dir, rel);
      return existsSync(candidate) ? pathToFileURL(candidate).href : null;
    });
  });
}

function locateMofloMemoryDist(): string | null {
  return locateMofloModuleDist('memory', 'index.js');
}

/**
 * Locate a filesystem path inside `src/modules/<pkg>/<rel>` (not limited to
 * `dist/`). Useful for non-built data folders shipped alongside the module
 * — e.g. spell YAML definitions, template assets.
 */
const moduleSubpathCache = new Map<string, string | null>();

export function locateMofloModulePath(pkg: MofloInternalPackage, rel: string): string | null {
  return memoize(moduleSubpathCache, `${pkg}::${rel}`, () => {
    const relPath = join('src', 'modules', pkg, rel);
    return walkUpFromSelf(dir => {
      const candidate = join(dir, relPath);
      return existsSync(candidate) ? candidate : null;
    });
  });
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

/**
 * Walk up to the moflo monorepo / installed-package root and join `rel`.
 *
 * "Moflo root" is the first ancestor directory that contains a `src/modules/`
 * subtree — true for both the dev source tree (repo root) and an installed
 * tree (`node_modules/moflo/`). Use for files shipped at the root of moflo
 * (e.g. `scripts/*.sh`); the package walk-ups only see `src/modules/<pkg>/`.
 */
const rootPathCache = new Map<string, string | null>();

export function locateMofloRootPath(rel: string): string | null {
  return memoize(rootPathCache, rel, () =>
    walkUpFromSelf(dir => {
      if (!existsSync(join(dir, 'src', 'modules'))) return null;
      const candidate = join(dir, rel);
      return existsSync(candidate) ? candidate : null;
    }),
  );
}

// Test-only: reset the caches between unit tests that mutate the filesystem.
export function _resetMofloMemoryCacheForTest(): void {
  moduleDistUrlCache.clear();
  moduleSubpathCache.clear();
  rootPathCache.clear();
}
