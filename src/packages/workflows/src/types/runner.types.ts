/**
 * Workflow Runner Types
 *
 * Types for the sequential workflow executor.
 */

import type { StepOutput, ValidationError, MofloLevel, PrerequisiteResult } from './step-command.types.js';

// ============================================================================
// Error Codes
// ============================================================================

export type WorkflowErrorCode =
  | 'ARGUMENT_VALIDATION_FAILED'
  | 'CONDITION_TARGET_NOT_FOUND'
  | 'DEFINITION_VALIDATION_FAILED'
  | 'STEP_VALIDATION_FAILED'
  | 'STEP_EXECUTION_FAILED'
  | 'STEP_TIMEOUT'
  | 'STEP_CANCELLED'
  | 'UNKNOWN_STEP_TYPE'
  | 'CAPABILITY_DENIED'
  | 'MOFLO_LEVEL_DENIED'
  | 'ROLLBACK_FAILED'
  | 'INVALID_PAUSED_DEFINITION'
  | 'PAUSED_STATE_NOT_FOUND'
  | 'PAUSED_STATE_EXPIRED'
  | 'PREREQUISITES_FAILED'
  | 'WORKFLOW_CANCELLED';

// ============================================================================
// Step Result
// ============================================================================

export type StepStatus = 'succeeded' | 'failed' | 'skipped' | 'rolled_back' | 'cancelled';

export interface StepResult {
  readonly stepId: string;
  readonly stepType: string;
  readonly status: StepStatus;
  readonly output?: StepOutput;
  readonly error?: string;
  readonly errorCode?: WorkflowErrorCode;
  readonly duration: number;
  readonly rollbackAttempted?: boolean;
  readonly rollbackError?: string;
  /** The interpolated config that was actually executed (for rollback). */
  readonly interpolatedConfig?: Record<string, unknown>;
}

// ============================================================================
// Workflow Result
// ============================================================================

export interface WorkflowResult {
  readonly workflowId: string;
  readonly success: boolean;
  readonly steps: StepResult[];
  readonly outputs: Record<string, unknown>;
  readonly errors: WorkflowError[];
  readonly duration: number;
  readonly cancelled: boolean;
}

export interface WorkflowError {
  readonly stepId?: string;
  readonly code: WorkflowErrorCode;
  readonly message: string;
  readonly details?: ValidationError[];
}

// ============================================================================
// Dry-Run Result
// ============================================================================

export interface DryRunStepReport {
  readonly stepId: string;
  readonly stepType: string;
  readonly description: string;
  readonly interpolatedConfig: Record<string, unknown> | null;
  readonly validationResult: { valid: boolean; errors: ValidationError[] };
  readonly continueOnError: boolean;
  readonly hasRollback: boolean;
  /** Resolved MoFlo integration level for this step. */
  readonly mofloLevel?: MofloLevel;
  /** Prerequisite check results (populated during dry-run). */
  readonly prerequisiteResults?: readonly PrerequisiteResult[];
}

export interface DryRunResult {
  readonly valid: boolean;
  readonly argumentErrors: ValidationError[];
  readonly definitionErrors: ValidationError[];
  readonly steps: DryRunStepReport[];
}

// ============================================================================
// Runner Options
// ============================================================================

export interface RunnerOptions {
  /** Caller-specified workflow ID for status correlation. Auto-generated if omitted. */
  readonly workflowId?: string;

  /** Default timeout per step in milliseconds (default: 300000 — 5 min). */
  readonly defaultStepTimeout?: number;

  /** Dry-run mode: validate without executing (default: false). */
  readonly dryRun?: boolean;

  /** AbortSignal for cancellation. */
  readonly signal?: AbortSignal;

  /** Progress callback invoked after each step completes. */
  readonly onStepComplete?: (result: StepResult, index: number, total: number) => void;

  /** Literal credential values to redact from step output (matched as exact strings). */
  readonly credentialValues?: readonly string[];

  /** Pre-seeded variables for resuming from a paused workflow. */
  readonly initialVariables?: Record<string, unknown>;

  /** Current nesting depth for recursive workflow invocation (0 = top-level). */
  readonly nestingDepth?: number;

  /** Maximum nesting depth for recursive workflows (default: 3). */
  readonly maxNestingDepth?: number;

  /** Parent workflow's MoFlo level — child workflows cannot exceed this. */
  readonly parentMofloLevel?: MofloLevel;
}
