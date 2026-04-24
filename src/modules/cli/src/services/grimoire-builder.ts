/**
 * Grimoire Builder
 *
 * Shared helper for constructing the spell registry (Grimoire) from a
 * project's moflo.yaml + shipped definitions path. Used by the MCP spell
 * tools and by the daemon scheduler bootstrap so both discover the same
 * set of spells under the same precedence rules.
 */

import { resolve } from 'node:path';
import type { Grimoire } from '../../../../modules/spells/src/registry/spell-registry.js';
import { loadMofloConfig } from '../config/moflo-config.js';
import { loadSpellEngine, type EngineModule } from './engine-loader.js';
import { locateMofloModulePath } from './moflo-require.js';

/**
 * Resolve the shipped + user spell directories for a project.
 *
 * `shippedDir` defaults to the bundled `src/modules/spells/definitions` folder,
 * resolved via a depth-invariant walk-up (layout-safe across source, dist, and
 * installed-under-consumer's-node_modules/moflo/). The prior fixed-depth
 * `../../../../modules/spells/definitions` string silently pointed at the
 * wrong directory from the compiled `dist/src/services/` location — same class
 * of bug as PR #556.
 *
 * Returns an empty string when the shipped dir isn't present on disk (e.g.
 * pre-built source tree); the loader treats missing dirs as a no-op.
 */
export function resolveSpellDirs(projectRoot: string): { shippedDir: string; userDirs: string[] } {
  const config = loadMofloConfig(projectRoot);

  const defaultShippedDir = locateMofloModulePath('spells', 'definitions') ?? '';
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
