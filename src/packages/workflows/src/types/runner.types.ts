/**
 * Workflow Runner Types
 *
 * Types for the sequential workflow executor.
 */

import type { StepOutput, ValidationError } from './step-command.types.js';

// ============================================================================
// Error Codes
// ============================================================================

export type WorkflowErrorCode =
  | 'ARGUMENT_VALIDATION_FAILED'
  | 'DEFINITION_VALIDATION_FAILED'
  | 'STEP_VALIDATION_FAILED'
  | 'STEP_EXECUTION_FAILED'
  | 'STEP_TIMEOUT'
  | 'STEP_CANCELLED'
  | 'UNKNOWN_STEP_TYPE'
  | 'ROLLBACK_FAILED'
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
}
