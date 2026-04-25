/**
 * Shared Spell Engine Loader
 *
 * Centralizes the dynamic import + caching used by spell-tools.ts (MCP layer)
 * and runner-adapter.ts (epic runner). Deferred-import shape lets non-spell
 * cli subcommands skip evaluating the engine on startup.
 */

import type {
  SpellResult,
  PreflightWarning,
  PreflightWarningDecision,
  PreflightWarningHandler,
} from '../spells/types/runner.types.js';
import type {
  SpellDefinition,
} from '../spells/types/spell-definition.types.js';
import type {
  Grimoire,
  RegistryOptions,
} from '../spells/registry/spell-registry.js';
import type { SandboxConfig } from '../spells/core/platform-sandbox.js';
import type {
  SpellScheduler,
  SpellExecutor,
} from '../spells/scheduler/scheduler.js';
import type { SchedulerOptions } from '../spells/scheduler/schedule.types.js';
import type { MemoryAccessor } from '../spells/types/step-command.types.js';

// Re-export spell types so consumers import from engine-loader (single boundary).
export type { SpellResult };
export type { SpellDefinition };
export type { Grimoire };
export type { PreflightWarning, PreflightWarningDecision, PreflightWarningHandler };
export type { SandboxConfig };
export type { SpellScheduler, SpellExecutor, SchedulerOptions };

/**
 * Shape of the dynamically imported spell engine module.
 */
export interface EngineModule {
  bridgeRunSpell: (
    content: string,
    sourceFile: string | undefined,
    args: Record<string, unknown>,
    options?: { dryRun?: boolean; projectRoot?: string; memory?: unknown; sandboxConfig?: SandboxConfig },
  ) => Promise<SpellResult>;
  bridgeExecuteSpell: (
    definition: SpellDefinition,
    args: Record<string, unknown>,
    options?: { spellId?: string; projectRoot?: string; memory?: unknown; sandboxConfig?: SandboxConfig },
  ) => Promise<SpellResult>;
  bridgeCancelSpell: (spellId: string) => boolean;
  bridgeIsRunning: (spellId: string) => boolean;
  bridgeActiveSpells: () => string[];
  Grimoire: new (options?: RegistryOptions) => Grimoire;
  SpellScheduler: new (
    memory: MemoryAccessor,
    executor: SpellExecutor,
    options?: SchedulerOptions,
  ) => SpellScheduler;
  runSpellFromContent: (
    content: string,
    sourceFile: string | undefined,
    options?: Record<string, unknown>,
  ) => Promise<SpellResult>;
  loadSandboxConfigFromProject: (projectRoot: string) => Promise<SandboxConfig>;
  registerTTYPauser: (pauser: () => { release: () => void }) => () => void;
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
      const mod = await import(
        /* webpackIgnore: true */
        '../spells/index.js'
      );
      cachedEngine = mod as unknown as EngineModule;
      return cachedEngine;
    } catch {
      throw new Error(
        'Spell engine not available. Run `npm run build` to compile the cli package.',
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
