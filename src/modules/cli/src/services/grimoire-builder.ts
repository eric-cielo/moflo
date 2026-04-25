/**
 * Grimoire Builder
 *
 * Shared helper for constructing the spell registry (Grimoire) from a
 * project's moflo.yaml + shipped definitions path. Used by the MCP spell
 * tools and by the daemon scheduler bootstrap so both discover the same
 * set of spells under the same precedence rules.
 */

import { resolve } from 'node:path';
import { loadMofloConfig } from '../config/moflo-config.js';
import { loadSpellEngine, type EngineModule, type Grimoire } from './engine-loader.js';
import { locateMofloModulePath } from './moflo-require.js';

/**
 * Resolve the shipped + user spell directories for a project. Returns an
 * empty `shippedDir` when the bundled definitions folder is absent; the
 * loader treats missing dirs as a no-op.
 */
export function resolveSpellDirs(projectRoot: string): { shippedDir: string; userDirs: string[] } {
  const config = loadMofloConfig(projectRoot);

  const defaultShippedDir = locateMofloModulePath('cli', 'src/spells/definitions') ?? '';
  const shippedDir = config.spells.shippedDir
    ? resolve(projectRoot, config.spells.shippedDir)
    : defaultShippedDir;
  const userDirs = config.spells.userDirs.map(d => resolve(projectRoot, d));

  return { shippedDir, userDirs };
}

/**
 * Build (and eagerly load) a Grimoire for the given project. Reuses an
 * already-loaded engine module when provided; otherwise loads lazily.
 */
export async function buildGrimoire(
  projectRoot: string,
  engine?: EngineModule,
): Promise<{ registry: Grimoire; engine: EngineModule }> {
  const loaded = engine ?? await loadSpellEngine();
  const { shippedDir, userDirs } = resolveSpellDirs(projectRoot);
  const registry = new loaded.Grimoire({ shippedDir, userDirs });
  registry.load();
  return { registry, engine: loaded };
}
