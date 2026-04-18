/**
 * Daemon Spell Executor
 *
 * Production SpellExecutor implementation for the worker daemon.
 * Resolves spells via the Grimoire registry, delegates execution to the
 * shared spell engine (same path as `flo spell cast`), and propagates
 * abort signals to the engine's internal spell tracker.
 */

import type {
  SpellExecutor,
} from '../../../spells/src/scheduler/scheduler.js';
import type {
  MofloLevel,
  MemoryAccessor,
} from '../../../spells/src/types/step-command.types.js';
import type { SpellResult, SpellErrorCode } from '../../../spells/src/types/runner.types.js';
import type { SpellDefinition } from '../../../spells/src/types/spell-definition.types.js';
import type { Grimoire } from '../../../spells/src/registry/spell-registry.js';
import {
  loadSpellEngine,
  type EngineModule,
  type SandboxConfig,
} from './engine-loader.js';

export interface DaemonSpellExecutorOptions {
  /** Pre-built Grimoire used to resolve spell names at poll time. */
  readonly registry: Grimoire;
  /** Project root passed through to the engine for sandbox + path resolution. */
  readonly projectRoot: string;
  /** Memory accessor shared with the scheduler; also passed to the runner. */
  readonly memory?: MemoryAccessor;
  /** Fallback level when a scheduled spell + definition both omit one. */
  readonly defaultMofloLevel?: MofloLevel;
  /** Optional pre-loaded engine module (else loaded lazily on first execute). */
  readonly engine?: EngineModule;
  /** Optional sandbox config override (else auto-loaded from moflo.yaml). */
  readonly sandboxConfig?: SandboxConfig;
}

export class DaemonSpellExecutor implements SpellExecutor {
  private readonly registry: Grimoire;
  private readonly projectRoot: string;
  private readonly memory?: MemoryAccessor;
  private readonly defaultMofloLevel?: MofloLevel;
  private readonly explicitSandbox?: SandboxConfig;
  private engine?: EngineModule;

  constructor(opts: DaemonSpellExecutorOptions) {
    this.registry = opts.registry;
    this.projectRoot = opts.projectRoot;
    this.memory = opts.memory;
    this.defaultMofloLevel = opts.defaultMofloLevel;
    this.engine = opts.engine;
    this.explicitSandbox = opts.sandboxConfig;
  }

  exists(spellName: string): boolean {
    return this.registry.resolve(spellName) !== undefined;
  }

  async execute(
    spellName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    mofloLevel?: MofloLevel,
  ): Promise<SpellResult> {
    const loaded = this.registry.resolve(spellName);
    if (!loaded) {
      return failedResult(
        `scheduled-${spellName}-${Date.now()}`,
        'STEP_EXECUTION_FAILED',
        `Spell not found in grimoire: ${spellName}`,
      );
    }

    const engine = await this.ensureEngine();
    const definition = this.applyMofloLevel(loaded.definition, mofloLevel);
    const spellId = `scheduled-${loaded.definition.name}-${Date.now()}`;

    const onAbort = () => {
      try {
        engine.bridgeCancelSpell(spellId);
      } catch (err) {
        // Cancellation is best-effort — the engine may have already finished.
        // Emit to stderr so daemon logs capture the case without disrupting
        // the poll loop or propagating the failure back to the scheduler.
        console.warn(`[daemon-spell-executor] bridgeCancelSpell(${spellId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const sandboxConfig = this.explicitSandbox
        ?? await engine.loadSandboxConfigFromProject(this.projectRoot);
      return await engine.bridgeExecuteSpell(definition, args, {
        spellId,
        projectRoot: this.projectRoot,
        memory: this.memory,
        sandboxConfig,
      });
    } catch (err) {
      return failedResult(
        spellId,
        'STEP_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async ensureEngine(): Promise<EngineModule> {
    if (!this.engine) this.engine = await loadSpellEngine();
    return this.engine;
  }

  private applyMofloLevel(definition: SpellDefinition, scheduled?: MofloLevel): SpellDefinition {
    const effective = scheduled ?? definition.mofloLevel ?? this.defaultMofloLevel;
    if (!effective || effective === definition.mofloLevel) return definition;
    return { ...definition, mofloLevel: effective };
  }
}

function failedResult(spellId: string, code: SpellErrorCode, message: string): SpellResult {
  return {
    spellId,
    success: false,
    steps: [],
    outputs: {},
    errors: [{ code, message }],
    duration: 0,
    cancelled: false,
  };
}
