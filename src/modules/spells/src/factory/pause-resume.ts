/**
 * Spell Pause/Resume
 *
 * Serializes spell execution state to memory for cross-conversation
 * survival, and reconstructs it for resumption.
 */

import type { MemoryAccessor } from '../types/step-command.types.js';
import type { SpellDefinition } from '../types/spell-definition.types.js';
import type { SpellResult, StepResult } from '../types/runner.types.js';
import { createRunner, noopMemory } from './runner-factory.js';
import { validateSpellDefinition } from '../schema/validator.js';
import { sanitizeObjectKeys } from '../core/interpolation.js';

// ============================================================================
// Types
// ============================================================================

export interface PausedState {
  readonly spellId: string;
  readonly definitionName: string;
  /** Serialized spell definition (JSON). */
  readonly definition: string;
  /** Index of the next step to execute (0-based). */
  readonly nextStepIndex: number;
  /** Variable context at pause time. */
  readonly variables: Record<string, unknown>;
  /** Results of steps completed before pause. */
  readonly completedStepResults: StepResult[];
  /** Arguments originally passed to the spell. */
  readonly args: Record<string, unknown>;
  /** ISO timestamp of when the spell was paused. */
  readonly pausedAt: string;
  /** Configurable timeout (ms) after which paused state is considered stale. */
  readonly staleAfterMs: number;
}

export interface ResumeOptions {
  /** Override variables before resuming (e.g. user edits between pause/resume). */
  readonly variables?: Record<string, unknown>;
  /** Memory accessor for reading paused state and storing progress. */
  readonly memory?: MemoryAccessor;
}

const PAUSE_NAMESPACE = 'spell-paused';
/** Legacy namespace — checked for migration from pre-spell terminology. */
const LEGACY_PAUSE_NAMESPACE = 'workflow-paused';
const DEFAULT_STALE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Pause
// ============================================================================

/**
 * Persist paused spell state to memory.
 */
export async function persistPausedState(
  state: PausedState,
  memory: MemoryAccessor,
): Promise<void> {
  await memory.write(PAUSE_NAMESPACE, state.spellId, state);
}

/**
 * Create a PausedState from execution context.
 */
export function buildPausedState(
  spellId: string,
  definition: SpellDefinition,
  nextStepIndex: number,
  variables: Record<string, unknown>,
  completedStepResults: StepResult[],
  args: Record<string, unknown>,
  staleAfterMs: number = DEFAULT_STALE_TIMEOUT,
): PausedState {
  return {
    spellId,
    definitionName: definition.name,
    definition: JSON.stringify(definition),
    nextStepIndex,
    variables: structuredClone(variables),
    completedStepResults: structuredClone(completedStepResults),
    args: structuredClone(args),
    pausedAt: new Date().toISOString(),
    staleAfterMs,
  };
}

// ============================================================================
// Resume
// ============================================================================

/**
 * Load paused state from memory and resume execution.
 */
export async function resumeSpell(
  spellId: string,
  options: ResumeOptions = {},
): Promise<SpellResult> {
  const memory = options.memory ?? noopMemory;
  let raw = await memory.read(PAUSE_NAMESPACE, spellId);

  // Migrate from legacy namespace if not found in new one
  if (!raw) {
    raw = await memory.read(LEGACY_PAUSE_NAMESPACE, spellId);
    if (raw) {
      // Migrate: write to new namespace, clear legacy
      await memory.write(PAUSE_NAMESPACE, spellId, raw);
      await memory.write(LEGACY_PAUSE_NAMESPACE, spellId, null);
    }
  }

  if (!raw) {
    return {
      spellId,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'PAUSED_STATE_NOT_FOUND', message: `No paused state found for spell "${spellId}"` }],
      duration: 0,
      cancelled: false,
    };
  }

  const state = raw as PausedState;

  // Check staleness
  const pausedTime = new Date(state.pausedAt).getTime();
  if (Date.now() - pausedTime > state.staleAfterMs) {
    await memory.write(PAUSE_NAMESPACE, spellId, null);
    return {
      spellId,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'PAUSED_STATE_EXPIRED', message: `Paused state for "${spellId}" has expired (stale after ${state.staleAfterMs}ms)` }],
      duration: 0,
      cancelled: false,
    };
  }

  // Reconstruct and re-validate definition (defense against tampered paused state)
  const rawDefinition = sanitizeObjectKeys(JSON.parse(state.definition)) as SpellDefinition;
  const validation = validateSpellDefinition(rawDefinition);
  if (!validation.valid) {
    await memory.write(PAUSE_NAMESPACE, spellId, null);
    return {
      spellId,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'INVALID_PAUSED_DEFINITION', message: `Paused spell definition failed validation: ${validation.errors.map(e => e.message).join('; ')}` }],
      duration: 0,
      cancelled: false,
    };
  }
  const definition = rawDefinition;

  // Merge user-provided variable overrides
  const variables = { ...state.variables, ...options.variables };

  // Create runner and execute remaining steps
  const runner = createRunner({ memory });
  const remainingDefinition: SpellDefinition = {
    ...definition,
    steps: definition.steps.slice(state.nextStepIndex),
  };

  const startTime = Date.now();
  const result = await runner.run(remainingDefinition, state.args, { spellId, initialVariables: variables });

  // Clean up paused state on completion
  await memory.write(PAUSE_NAMESPACE, spellId, null);

  // Merge completed step results from before pause with resume results
  const allSteps = [...state.completedStepResults, ...result.steps];
  const allOutputs: Record<string, unknown> = {};
  for (const sr of allSteps) {
    if (sr.status === 'succeeded' && sr.output) {
      allOutputs[sr.stepId] = sr.output.data;
    }
  }

  return {
    spellId,
    success: result.success,
    steps: allSteps,
    outputs: { ...allOutputs, ...result.outputs },
    errors: result.errors,
    duration: Date.now() - startTime,
    cancelled: result.cancelled,
  };
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Remove stale paused spells. Returns number of cleaned entries.
 */
export async function cleanupStalePaused(memory: MemoryAccessor): Promise<number> {
  // Clean both current and legacy namespaces
  const [currentResults, legacyResults] = await Promise.all([
    memory.search(PAUSE_NAMESPACE, ''),
    memory.search(LEGACY_PAUSE_NAMESPACE, '').catch(() => []),
  ]);
  let cleaned = 0;

  // Tag entries with their source namespace to avoid redundant writes
  const tagged: Array<{ ns: string; value: unknown }> = [
    ...currentResults.map(e => ({ ns: PAUSE_NAMESPACE, value: e.value })),
    ...legacyResults.map(e => ({ ns: LEGACY_PAUSE_NAMESPACE, value: e.value })),
  ];

  for (const { ns, value } of tagged) {
    const state = value as PausedState | undefined;
    if (state?.pausedAt && state?.staleAfterMs) {
      const pausedTime = new Date(state.pausedAt).getTime();
      if (Date.now() - pausedTime > state.staleAfterMs) {
        await memory.write(ns, state.spellId, null);
        cleaned++;
      }
    }
  }

  return cleaned;
}

