/**
 * Shared dependency resolver for moflo bin scripts.
 * Resolves packages from moflo's own node_modules (not the consuming project's).
 * On Windows, converts native paths to file:// URLs required by ESM import().
 */

import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __require = createRequire(fileURLToPath(import.meta.url));

export function mofloResolveURL(specifier) {
  return pathToFileURL(__require.resolve(specifier)).href;
}

/**
 * Resolve a path inside the installed `moflo` package itself. Used by bin
 * scripts to load moflo's own compiled dist modules without needing a publish
 * `exports` map for every internal path. Resolves relative to moflo's
 * `package.json` so it works the same in `node_modules/moflo/` (consumer
 * install) and in moflo's source tree (CI / dev).
 */
export function mofloInternalURL(internalPath) {
  const mofloRoot = dirname(__require.resolve('moflo/package.json'));
  return pathToFileURL(join(mofloRoot, internalPath)).href;
}
