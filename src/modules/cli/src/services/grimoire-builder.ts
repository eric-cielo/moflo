/**
 * Grimoire Builder
 *
 * Shared helper for constructing the spell registry (Grimoire) from a
 * project's moflo.yaml + shipped definitions path. Used by the MCP spell
 * tools and by the daemon scheduler bootstrap so both discover the same
 * set of spells under the same precedence rules.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Grimoire } from '../../../../modules/spells/src/registry/spell-registry.js';
import { loadMofloConfig } from '../config/moflo-config.js';
import { loadSpellEngine, type EngineModule } from './engine-loader.js';

/**
 * Resolve the shipped + user spell directories for a project.
 *
 * `shippedDir` defaults to the bundled `modules/spells/definitions` folder
 * relative to this file, so it keeps working in both source and dist layouts
 * per `feedback_consumer_path_resolution` (always anchored to `import.meta.url`).
 */
export function resolveSpellDirs(projectRoot: string): { shippedDir: string; userDirs: string[] } {
  const config = loadMofloConfig(projectRoot);

  const defaultShippedDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../modules/spells/definitions',
  );
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
