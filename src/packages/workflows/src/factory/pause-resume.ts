/**
 * Workflow Pause/Resume
 *
 * Serializes workflow execution state to memory for cross-conversation
 * survival, and reconstructs it for resumption.
 */

import type { MemoryAccessor } from '../types/step-command.types.js';
import type { WorkflowDefinition } from '../types/workflow-definition.types.js';
import type { WorkflowResult, StepResult } from '../types/runner.types.js';
import { createRunner, noopMemory } from './runner-factory.js';

// ============================================================================
// Types
// ============================================================================

export interface PausedState {
  readonly workflowId: string;
  readonly definitionName: string;
  /** Serialized workflow definition (JSON). */
  readonly definition: string;
  /** Index of the next step to execute (0-based). */
  readonly nextStepIndex: number;
  /** Variable context at pause time. */
  readonly variables: Record<string, unknown>;
  /** Results of steps completed before pause. */
  readonly completedStepResults: StepResult[];
  /** Arguments originally passed to the workflow. */
  readonly args: Record<string, unknown>;
  /** ISO timestamp of when the workflow was paused. */
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

const PAUSE_NAMESPACE = 'workflow-paused';
const DEFAULT_STALE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Pause
// ============================================================================

/**
 * Persist paused workflow state to memory.
 */
export async function persistPausedState(
  state: PausedState,
  memory: MemoryAccessor,
): Promise<void> {
  await memory.write(PAUSE_NAMESPACE, state.workflowId, state);
}

/**
 * Create a PausedState from execution context.
 */
export function buildPausedState(
  workflowId: string,
  definition: WorkflowDefinition,
  nextStepIndex: number,
  variables: Record<string, unknown>,
  completedStepResults: StepResult[],
  args: Record<string, unknown>,
  staleAfterMs: number = DEFAULT_STALE_TIMEOUT,
): PausedState {
  return {
    workflowId,
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
export async function resumeWorkflow(
  workflowId: string,
  options: ResumeOptions = {},
): Promise<WorkflowResult> {
  const memory = options.memory ?? noopMemory;
  const raw = await memory.read(PAUSE_NAMESPACE, workflowId);

  if (!raw) {
    return {
      workflowId,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'PAUSED_STATE_NOT_FOUND', message: `No paused state found for workflow "${workflowId}"` }],
      duration: 0,
      cancelled: false,
    };
  }

  const state = raw as PausedState;

  // Check staleness
  const pausedTime = new Date(state.pausedAt).getTime();
  if (Date.now() - pausedTime > state.staleAfterMs) {
    await memory.write(PAUSE_NAMESPACE, workflowId, null);
    return {
      workflowId,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'PAUSED_STATE_EXPIRED', message: `Paused state for "${workflowId}" has expired (stale after ${state.staleAfterMs}ms)` }],
      duration: 0,
      cancelled: false,
    };
  }

  // Reconstruct definition
  const definition: WorkflowDefinition = JSON.parse(state.definition);

  // Merge user-provided variable overrides
  const variables = { ...state.variables, ...options.variables };

  // Create runner and execute remaining steps
  const runner = createRunner({ memory });
  const remainingDefinition: WorkflowDefinition = {
    ...definition,
    steps: definition.steps.slice(state.nextStepIndex),
  };

  const startTime = Date.now();
  const result = await runner.run(remainingDefinition, state.args, { workflowId, initialVariables: variables });

  // Clean up paused state on completion
  await memory.write(PAUSE_NAMESPACE, workflowId, null);

  // Merge completed step results from before pause with resume results
  const allSteps = [...state.completedStepResults, ...result.steps];
  const allOutputs: Record<string, unknown> = {};
  for (const sr of allSteps) {
    if (sr.status === 'succeeded' && sr.output) {
      allOutputs[sr.stepId] = sr.output.data;
    }
  }

  return {
    workflowId,
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
 * Remove stale paused workflows. Returns number of cleaned entries.
 */
export async function cleanupStalePaused(memory: MemoryAccessor): Promise<number> {
  const results = await memory.search(PAUSE_NAMESPACE, '');
  let cleaned = 0;

  for (const entry of results) {
    const state = entry.value as PausedState | undefined;
    if (state?.pausedAt && state?.staleAfterMs) {
      const pausedTime = new Date(state.pausedAt).getTime();
      if (Date.now() - pausedTime > state.staleAfterMs) {
        await memory.write(PAUSE_NAMESPACE, state.workflowId, null);
        cleaned++;
      }
    }
  }

  return cleaned;
}

