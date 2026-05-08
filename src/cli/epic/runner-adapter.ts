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
import type { MemoryAccessor } from '../spells/types/step-command.types.js';

/**
 * Wrap a MemoryAccessor with a write-failure counter so the [epic] summary
 * can warn when spell progress didn't reach disk (#982). Without this, a
 * persist failure surfaces only as a `[spell] storeProgress(...) failed`
 * line buried mid-run, easily missed in shell scrollback.
 */
function trackPersistFailures(inner: MemoryAccessor): MemoryAccessor & { failedWrites: number } {
  const tracker = {
    failedWrites: 0,
    async read(ns: string, key: string) { return inner.read(ns, key); },
    async write(ns: string, key: string, value: unknown) {
      try {
        await inner.write(ns, key, value);
      } catch (err) {
        tracker.failedWrites++;
        throw err;
      }
    },
    async search(ns: string, query: string) { return inner.search(ns, query); },
  };
  return tracker;
}

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
  onStepComplete?: (
    step: {
      stepId: string;
      status: string;
      duration: number;
      error?: string;
      output?: { success: boolean; data: Record<string, unknown>; error?: string; duration?: number };
    },
    index: number,
    total: number,
  ) => void;
  /** Called when one or more warning-severity preflights fail. */
  onPreflightWarnings?: (warnings: readonly PreflightWarning[]) => Promise<readonly PreflightWarningDecision[]>;
}

export type { PreflightWarning, PreflightWarningDecision };

/** Cached memory accessor — created once per process. */
let memoryAccessor: ReturnType<typeof trackPersistFailures> | null = null;

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
      const inner = await createDashboardMemoryAccessor();
      memoryAccessor = trackPersistFailures(inner);
      console.log('[epic] Memory accessor ready — spell progress will be persisted');
    } catch (err) {
      console.warn(`[epic] ⚠ Dashboard memory unavailable: ${(err as Error).message ?? err}`);
      console.warn('[epic] ⚠ Spell executions will NOT appear in the dashboard');
    }
  }

  // memoryAccessor is module-cached, so `failedWrites` is cumulative across
  // every spell run in this process. Capturing the count BEFORE this run
  // and computing the delta below isolates "this run's failures" from any
  // prior run's. Spell runs are sequential per process, so no race.
  const failuresBefore = memoryAccessor?.failedWrites ?? 0;
  const runOpts = { ...options, projectRoot: process.cwd(), ...(memoryAccessor ? { memory: memoryAccessor } : {}) };

  // Print the persist-failure summary on every return path. Without this,
  // a #982-style failure surfaces only as scattered `[spell] storeProgress
  // failed` lines mid-run that get lost in scrollback. The summary line is
  // the user's signal that the dashboard / Luminarium will show empty
  // history despite a successful-looking spell run.
  const reportPersistFailures = (): void => {
    if (!memoryAccessor) return;
    const failed = memoryAccessor.failedWrites - failuresBefore;
    if (failed > 0) {
      console.warn(`[epic] ⚠ Spell progress was not fully persisted (${failed} write${failed === 1 ? '' : 's'} failed) — run history may be missing from the dashboard.`);
    }
  };

  let result = await engine.runSpellFromContent(
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
      reportPersistFailures();
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

    result = await engine.runSpellFromContent(
      yamlContent, undefined, runOpts,
    ) as EpicSpellResult;
  }

  reportPersistFailures();
  return result;
}
