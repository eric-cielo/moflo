/**
 * TS reader for the canonical shipped-scripts manifest
 * (`bin/lib/shipped-scripts.json`) — the single source of truth for the scripts
 * + helpers moflo syncs into a consumer's `.claude/` (issue #1191).
 *
 * The `.mjs` twin is `bin/lib/shipped-scripts.mjs`; both read the same JSON.
 * This module resolves it through `findMofloPackageRoot()` — the sanctioned
 * dist→bin resolver (see `.claude/guidance/internal/dogfooding.md` §2) that
 * works in dogfood TS, compiled dist, and consumer installs alike. NEVER a
 * hardcoded `../../../../bin/...` path (the depth differs between src and dist).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { findMofloPackageRoot } from '../services/moflo-require.js';

export interface ShippedScripts {
  scriptFiles: string[];
  binHelperFiles: string[];
  sourceHelperFiles: string[];
}

/**
 * Read the canonical shipped-scripts manifest. Pass the resolved `bin/lib`
 * directory to read a specific install's copy (callers that already resolved a
 * binDir — e.g. init's syncScripts — pass it so the list matches the exact dir
 * they copy from); omit it to resolve via `findMofloPackageRoot()`. Throws if
 * the manifest can't be located — that signals a broken install, which init and
 * upgrade can't proceed past anyway.
 */
export function loadShippedScripts(binLibDir?: string): ShippedScripts {
  let dir = binLibDir;
  if (!dir) {
    const root = findMofloPackageRoot();
    if (!root) {
      throw new Error('moflo package root not found — cannot read shipped-scripts manifest');
    }
    dir = join(root, 'bin', 'lib');
  }
  const manifest = JSON.parse(
    readFileSync(join(dir, 'shipped-scripts.json'), 'utf-8'),
  ) as Partial<ShippedScripts>;
  return {
    scriptFiles: manifest.scriptFiles ?? [],
    binHelperFiles: manifest.binHelperFiles ?? [],
    sourceHelperFiles: manifest.sourceHelperFiles ?? [],
  };
}
