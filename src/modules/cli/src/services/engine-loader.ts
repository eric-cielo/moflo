/**
 * Shared Spell Engine Loader
 *
 * Centralizes dynamic import + caching of the @moflo/spells package.
 * Both spell-tools.ts (MCP layer) and runner-adapter.ts (epic runner) use
 * this instead of maintaining their own import/cache logic.
 *
 * Story #229: Extract shared engine loader.
 * Story #230: Replaced *Like interfaces with import type from @moflo/spells.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  SpellResult,
  PreflightWarning,
  PreflightWarningDecision,
  PreflightWarningHandler,
} from '../../../../modules/spells/src/types/runner.types.js';
import type {
  SpellDefinition,
} from '../../../../modules/spells/src/types/spell-definition.types.js';
import type {
  Grimoire,
  RegistryOptions,
} from '../../../../modules/spells/src/registry/spell-registry.js';

// Re-export spell types so consumers import from engine-loader (single boundary).
export type { SpellResult };
export type { SpellDefinition };
export type { Grimoire };
export type { PreflightWarning, PreflightWarningDecision, PreflightWarningHandler };

/**
 * Shape of the dynamically imported spell engine module.
 *
 * Uses the canonical types from @moflo/spells (type-only, no runtime dep).
 * The actual module is loaded via dynamic import() at runtime.
 */
export interface EngineModule {
  bridgeRunSpell: (
    content: string,
    sourceFile: string | undefined,
    args: Record<string, unknown>,
    options?: { dryRun?: boolean },
  ) => Promise<SpellResult>;
  bridgeExecuteSpell: (
    definition: SpellDefinition,
    args: Record<string, unknown>,
    options?: { spellId?: string },
  ) => Promise<SpellResult>;
  bridgeCancelSpell: (spellId: string) => boolean;
  bridgeIsRunning: (spellId: string) => boolean;
  bridgeActiveSpells: () => string[];
  Grimoire: new (options?: RegistryOptions) => Grimoire;
  runSpellFromContent: (
    content: string,
    sourceFile: string | undefined,
    options?: Record<string, unknown>,
  ) => Promise<SpellResult>;
}

let cachedEngine: EngineModule | null = null;
let pendingImport: Promise<EngineModule> | null = null;

/**
 * Dynamically import the spell engine, caching after first successful load.
 * Uses a pending-promise guard to prevent duplicate imports under concurrency.
 */
export async function loadSpellEngine(): Promise<EngineModule> {
  if (cachedEngine) return cachedEngine;
  if (pendingImport) return pendingImport;

  pendingImport = (async () => {
    try {
      // Walk up from this file to find the @moflo/cli package root (contains package.json),
      // then resolve sibling spells package. Works from both compiled (dist/src/services/)
      // and source (src/services/) locations.
      const __engineDir = dirname(fileURLToPath(import.meta.url));
      let cliRoot = __engineDir;
      while (cliRoot !== dirname(cliRoot) && !existsSync(join(cliRoot, 'package.json'))) {
        cliRoot = dirname(cliRoot);
      }
      const spellsEntry = resolve(cliRoot, '..', 'spells', 'dist', 'index.js');
      const mod = await import(
        /* webpackIgnore: true */
        pathToFileURL(spellsEntry).href
      );
      cachedEngine = mod as unknown as EngineModule;
      return cachedEngine;
    } catch {
      throw new Error(
        'Spell engine not available. Run `npm run build` to compile the spells package.',
      );
    } finally {
      pendingImport = null;
    }
  })();

  return pendingImport;
}

/**
 * Return the cached engine module if already loaded, or null.
 * Useful for non-critical checks that should not trigger a dynamic import.
 */
export function getCachedEngine(): EngineModule | null {
  return cachedEngine;
}
