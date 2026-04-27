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
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';
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
 * Post-#602 there's only one — `cli` — and it's the entire moflo source. The
 * union is preserved as a typed sentinel so call sites still document intent.
 */
export type MofloInternalPackage = 'cli';

// Walk cap: deepest real install is `<consumer>/node_modules/moflo/dist/src/cli/<...>`
// ≈ 6 hops to the moflo root. 12 gives headroom for worktree/monorepo layouts.
const MAX_WALK_DEPTH = 12;

// Names a package.json may carry while still being "us" — covers the moflo
// rename and the upstream forks we tolerate during version migration.
const MOFLO_PACKAGE_NAMES = new Set(['moflo', 'claude-flow', 'ruflo']);

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

const mofloRootCache = new Map<string, string | null>();

/**
 * Locate the moflo package root — the first ancestor that has a `package.json`
 * whose `name` is "moflo" (or a tolerated legacy upstream during migration).
 * Works from both the dev source tree (repo root) and an installed tree
 * (`node_modules/moflo/`). Cached.
 *
 * This is the ONE walk-up routine — every other helper that needs to resolve
 * a path inside the moflo package should anchor here, not roll its own
 * `existsSync(...)` cascade. (Replaced the pre-#602 `src/modules/` anchor,
 * which silently broke after the workspace tree was collapsed.)
 */
export function findMofloPackageRoot(): string | null {
  return memoize(mofloRootCache, '__root__', () =>
    walkUpFromSelf(dir => {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) return null;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return typeof pkg.name === 'string' && MOFLO_PACKAGE_NAMES.has(pkg.name) ? dir : null;
      } catch {
        return null;
      }
    }),
  );
}

/**
 * Locate a built artifact inside `dist/src/cli/<relFromDist>` by anchoring on
 * the moflo package root. Returns a `file://` URL suitable for ESM `import()`.
 *
 * The `pkg` argument is preserved for call-site documentation; the helper
 * always resolves under `dist/src/<pkg>/`. Callers may pass `relFromDist`
 * with or without a leading `src/` (legacy callers wrote `'src/index.js'`
 * expecting the pre-collapse `dist/src/<file>` layout — that prefix is
 * stripped now so they land in `dist/src/cli/<file>`).
 */
const moduleDistUrlCache = new Map<string, string | null>();

export function locateMofloModuleDist(pkg: MofloInternalPackage, relFromDist: string): string | null {
  return memoize(moduleDistUrlCache, `${pkg}::${relFromDist}`, () => {
    const root = findMofloPackageRoot();
    if (!root) return null;
    const rel = relFromDist.replace(/^src[/\\]/, '');
    const candidate = join(root, 'dist', 'src', pkg, rel);
    return existsSync(candidate) ? pathToFileURL(candidate).href : null;
  });
}

/**
 * Locate a filesystem path under `src/<pkg>/<rel>` (not limited to `dist/`).
 * Useful for non-built data folders shipped alongside the source — e.g. spell
 * YAML definitions, template assets. Same `pkg` + `rel` shape as
 * `locateMofloModuleDist`, including the legacy `src/`-prefix tolerance.
 */
const moduleSubpathCache = new Map<string, string | null>();

export function locateMofloModulePath(pkg: MofloInternalPackage, rel: string): string | null {
  return memoize(moduleSubpathCache, `${pkg}::${rel}`, () => {
    const root = findMofloPackageRoot();
    if (!root) return null;
    const stripped = rel.replace(/^src[/\\]/, '');
    const candidate = join(root, 'src', pkg, stripped);
    return existsSync(candidate) ? candidate : null;
  });
}

/**
 * Walk up to the moflo package root and join `rel`. Use for files shipped at
 * the root of moflo (e.g. `scripts/*.sh`, `README.md`).
 */
const rootPathCache = new Map<string, string | null>();

export function locateMofloRootPath(rel: string): string | null {
  return memoize(rootPathCache, rel, () => {
    const root = findMofloPackageRoot();
    if (!root) return null;
    const candidate = join(root, rel);
    return existsSync(candidate) ? candidate : null;
  });
}

// Test-only: reset the caches between unit tests that mutate the filesystem.
export function _resetMofloMemoryCacheForTest(): void {
  moduleDistUrlCache.clear();
  moduleSubpathCache.clear();
  rootPathCache.clear();
  mofloRootCache.clear();
}
