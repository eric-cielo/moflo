/**
 * Epic Spell Runner Adapter
 *
 * Bridges the CLI epic command to the spell engine without direct
 * cross-package imports (avoids tsconfig rootDir issues).
 *
 * Story #197: Thin adapter for running spell YAML from epic command.
 * Story #229: Uses shared engine loader instead of inline dynamic import.
 */

import { loadSpellEngine, type SpellResult } from '../services/engine-loader.js';
import { createDashboardMemoryAccessor } from '../services/daemon-dashboard.js';

/** Minimal spell result shape matching SpellResult from @moflo/spells. */
export type EpicSpellResult = Pick<
  SpellResult,
  'spellId' | 'success' | 'outputs' | 'duration' | 'cancelled'
> & {
  steps: Array<{
    stepId: string;
    stepType: string;
    status: string;
    duration: number;
    error?: string;
  }>;
  errors: Array<{ code: string; message: string }>;
};

export interface EpicRunOptions {
  args?: Record<string, unknown>;
  dryRun?: boolean;
  onStepComplete?: (step: { stepId: string; status: string; duration: number; error?: string }, index: number, total: number) => void;
}

/** Cached memory accessor — created once per process. */
let memoryAccessor: Awaited<ReturnType<typeof createDashboardMemoryAccessor>> | null = null;

/**
 * Run a spell YAML string via the spell engine.
 *
 * Uses the shared engine loader (services/engine-loader.ts) which caches the
 * dynamically imported module. The spells package must be built first.
 */
export async function runEpicSpell(
  yamlContent: string,
  options: EpicRunOptions = {},
): Promise<EpicSpellResult> {
  const engine = await loadSpellEngine();

  // Lazily initialize a real memory accessor so execution records
  // are persisted and visible in the dashboard.
  if (!memoryAccessor) {
    try {
      memoryAccessor = await createDashboardMemoryAccessor();
      console.log('[epic] Memory accessor ready — spell progress will be persisted');
    } catch (err) {
      console.warn(`[epic] ⚠ Dashboard memory unavailable: ${(err as Error).message ?? err}`);
      console.warn('[epic] ⚠ Spell executions will NOT appear in the dashboard');
    }
  }

  return engine.runSpellFromContent(
    yamlContent,
    undefined,
    { ...options, ...(memoryAccessor ? { memory: memoryAccessor } : {}) },
  ) as Promise<EpicSpellResult>;
}
