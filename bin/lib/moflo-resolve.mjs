/**
 * Shared dependency resolver for moflo bin scripts.
 * Resolves packages from moflo's own node_modules (not the consuming project's).
 * On Windows, converts native paths to file:// URLs required by ESM import().
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __require = createRequire(fileURLToPath(import.meta.url));

export function mofloResolveURL(specifier) {
  return pathToFileURL(__require.resolve(specifier)).href;
}
