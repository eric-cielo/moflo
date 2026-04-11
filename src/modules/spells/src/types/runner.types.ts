/**
 * Spell Runner Types
 *
 * Types for the sequential spell executor.
 */

import type { StepOutput, ValidationError, MofloLevel, PrerequisiteResult } from './step-command.types.js';
import type { PermissionLevel, ResolvedPermissions } from '../core/permission-resolver.js';
import type { PermissionWarning, RiskLevel } from '../core/permission-disclosure.js';
import type { SandboxConfig } from '../core/platform-sandbox.js';

// ============================================================================
// Error Codes
// ============================================================================

export type SpellErrorCode =
  | 'ACCEPTANCE_REQUIRED'
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
  | 'SPELL_CANCELLED';

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
  readonly errorCode?: SpellErrorCode;
  readonly duration: number;
  readonly rollbackAttempted?: boolean;
  readonly rollbackError?: string;
  /** The interpolated config that was actually executed (for rollback). */
  readonly interpolatedConfig?: Record<string, unknown>;
}

// ============================================================================
// Spell Result
// ============================================================================

export interface SpellResult {
  readonly spellId: string;
  readonly success: boolean;
  readonly steps: StepResult[];
  readonly outputs: Record<string, unknown>;
  readonly errors: SpellError[];
  readonly duration: number;
  readonly cancelled: boolean;
}

export interface SpellError {
  readonly stepId?: string;
  readonly code: SpellErrorCode;
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
  /** Resolved permission level for Claude CLI invocations. */
  readonly permissionLevel?: PermissionLevel;
  /** Full resolved permissions (tools, flags). */
  readonly resolvedPermissions?: ResolvedPermissions;
  /** Risk classification for this step's capabilities. */
  readonly riskLevel?: RiskLevel;
  /** Destructive/sensitive warnings for this step. */
  readonly permissionWarnings?: readonly PermissionWarning[];
  /** Destructive override configuration, if present (Issue #419). */
  readonly destructiveOverride?: {
    readonly type: 'boolean' | 'scoped';
    readonly scope?: readonly string[];
    readonly deprecated?: boolean;
  };
}

export interface DryRunResult {
  readonly valid: boolean;
  readonly argumentErrors: ValidationError[];
  readonly definitionErrors: ValidationError[];
  readonly steps: DryRunStepReport[];
  /** SHA-256 hash of the spell's permission profile (changes when permissions change). */
  readonly permissionHash?: string;
  /** Highest risk level across all steps. */
  readonly overallRisk?: RiskLevel;
}

// ============================================================================
// Flo Run Context — human-readable metadata for dashboard display
// ============================================================================

export interface FloRunContext {
  /** Run type: ticket, epic, spell, research, new-ticket */
  readonly type: 'ticket' | 'epic' | 'spell' | 'research' | 'new-ticket';
  /** Human-readable display label, e.g. "#350 — Replace zod with valibot" */
  readonly label: string;
  /** GitHub issue number (if applicable) */
  readonly issueNumber?: number;
  /** GitHub issue title (if applicable) */
  readonly issueTitle?: string;
  /** Spell name for -wf runs */
  readonly spellName?: string;
  /** Positional args for -wf runs */
  readonly spellArgs?: string[];
  /** Execution mode badge */
  readonly execMode?: 'normal' | 'swarm' | 'hive';
  /** Epic story progress: [completed, total] */
  readonly epicProgress?: readonly [number, number];
}

// ============================================================================
// Runner Options
// ============================================================================

export interface RunnerOptions {
  /** Caller-specified spell ID for status correlation. Auto-generated if omitted. */
  readonly spellId?: string;

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

  /** Pre-seeded variables for resuming from a paused spell. */
  readonly initialVariables?: Record<string, unknown>;

  /** Current nesting depth for recursive spell invocation (0 = top-level). */
  readonly nestingDepth?: number;

  /** Maximum nesting depth for recursive spells (default: 3). */
  readonly maxNestingDepth?: number;

  /** Parent spell's MoFlo level — child spells cannot exceed this. */
  readonly parentMofloLevel?: MofloLevel;

  /** Human-readable context metadata for dashboard display. */
  readonly context?: FloRunContext;

  /** OS-level sandbox configuration from moflo.yaml. */
  readonly sandboxConfig?: SandboxConfig;

  /** Project root for acceptance gate storage (.moflo/accepted-permissions/). */
  readonly projectRoot?: string;

  /** Skip the first-run acceptance gate (e.g. for internal/nested spells). */
  readonly skipAcceptanceCheck?: boolean;
}
