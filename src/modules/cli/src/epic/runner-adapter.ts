/**
 * Epic Spell Runner Adapter
 *
 * Bridges the CLI epic command to the spell engine without direct
 * cross-package imports (avoids tsconfig rootDir issues).
 *
 * Story #197: Thin adapter for running spell YAML from epic command.
 * Story #229: Uses shared engine loader instead of inline dynamic import.
 */

import * as readline from 'node:readline';
import {
  loadSpellEngine,
  type SpellResult,
  type PreflightWarning,
  type PreflightWarningDecision,
} from '../services/engine-loader.js';
import { createDashboardMemoryAccessor } from '../services/daemon-dashboard.js';

/** Minimal spell result shape matching SpellResult from the inlined spell engine. */
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
  /** Called when one or more warning-severity preflights fail. */
  onPreflightWarnings?: (warnings: readonly PreflightWarning[]) => Promise<readonly PreflightWarningDecision[]>;
}

export type { PreflightWarning, PreflightWarningDecision };

/** Cached memory accessor — created once per process. */
let memoryAccessor: Awaited<ReturnType<typeof createDashboardMemoryAccessor>> | null = null;

/** Prompt the user to accept or decline spell permissions. */
async function promptAcceptPermissions(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(resolve => {
      rl.question('\n[epic] Accept these permissions? (y/N) ', resolve);
    });
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

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

  const runOpts = { ...options, projectRoot: process.cwd(), ...(memoryAccessor ? { memory: memoryAccessor } : {}) };

  const result = await engine.runSpellFromContent(
    yamlContent, undefined, runOpts,
  ) as EpicSpellResult;

  // Auto-accept permissions on first run: the spell runner already printed
  // the full risk analysis to the console. The user initiated the epic
  // command, so we accept on their behalf and retry immediately.
  const hasAcceptanceError = !result.success &&
    result.errors.some(e => (e as Record<string, unknown>).code === 'ACCEPTANCE_REQUIRED');

  if (hasAcceptanceError) {
    const accepted = await promptAcceptPermissions();
    if (!accepted) {
      return result;
    }

    // Use the already-loaded engine module (dynamic import) for spells internals.
    // Static cross-package imports break when installed as a dependency because
    // the relative paths from dist/ don't match the source layout.
    const spells = engine as unknown as Record<string, unknown>;
    const { parseSpell, StepCommandRegistry, builtinCommands, analyzeSpellPermissions, recordAcceptance } = spells as {
      parseSpell: (content: string) => { definition: { name: string } };
      StepCommandRegistry: new () => { register: (cmd: unknown, source: string) => void };
      builtinCommands: unknown[];
      analyzeSpellPermissions: (def: unknown, reg: unknown) => { permissionHash: string };
      recordAcceptance: (root: string, name: string, hash: string) => Promise<void>;
    };

    const projectRoot = process.cwd();
    const parsed = parseSpell(yamlContent);
    const stepRegistry = new StepCommandRegistry();
    for (const cmd of builtinCommands) {
      stepRegistry.register(cmd, 'built-in');
    }
    const report = analyzeSpellPermissions(parsed.definition, stepRegistry);

    await recordAcceptance(projectRoot, parsed.definition.name, report.permissionHash);
    console.log(`[epic] Permissions accepted for "${parsed.definition.name}" — retrying...\n`);

    return engine.runSpellFromContent(
      yamlContent, undefined, runOpts,
    ) as Promise<EpicSpellResult>;
  }

  return result;
}
