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
 *   const transformers = await mofloImport('@xenova/transformers');
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

// createRequire anchored to this file — resolves from moflo's own node_modules
const mofloRequire = createRequire(fileURLToPath(import.meta.url));

/**
 * Dynamically import a package, resolving from moflo's own node_modules first.
 * Falls back to bare import only if local resolution fails (e.g. monorepo hoisting).
 *
 * On Windows, `createRequire.resolve()` returns a native path (C:\...) which
 * `import()` rejects — it requires a file:// URL.  We convert via pathToFileURL.
 *
 * @param specifier       Package specifier, e.g. 'sql.js' or '@xenova/transformers'
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
 * Import `@moflo/memory` from within a moflo source module. The root `moflo`
 * package ships @moflo/memory as a source folder rather than a declared
 * dependency, so `mofloImport('@moflo/memory')` fails in consumer installs
 * (node_modules/@moflo/memory/ doesn't exist). Fall back to a URL resolved
 * relative to the caller's file — the same src/modules/memory/dist/index.js
 * layout holds in both dev and consumer.
 *
 * @param callerUrl `import.meta.url` of the file that needs @moflo/memory
 */
export async function importMofloMemory(callerUrl: string): Promise<any> {
  const viaRequire = await mofloImport('@moflo/memory');
  if (viaRequire) return viaRequire;
  const memoryUrl = new URL('../../../../memory/dist/index.js', callerUrl);
  return import(memoryUrl.href);
}
