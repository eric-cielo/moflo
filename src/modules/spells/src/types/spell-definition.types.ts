/**
 * Spell Definition Types
 *
 * TypeScript types for YAML/JSON spell definition files.
 */

import type { CapabilityType, MofloLevel } from './step-command.types.js';
import type { PermissionLevel } from '../core/permission-resolver.js';
import type { ScheduleDefinition } from '../scheduler/schedule.types.js';

// ============================================================================
// Argument Definitions
// ============================================================================

export type ArgumentType = 'string' | 'number' | 'boolean' | 'string[]';

export interface ArgumentDefinition {
  readonly type: ArgumentType;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly description?: string;
}

// ============================================================================
// Step Definitions
// ============================================================================

export interface StepDefinition {
  readonly id: string;
  readonly type: string;
  readonly config: Record<string, unknown>;
  readonly output?: string;
  readonly continueOnError?: boolean;
  /** Nested steps for condition/loop commands. */
  readonly steps?: readonly StepDefinition[];
  /** Capability restrictions for this step (narrows the command's defaults). */
  readonly capabilities?: Partial<Record<CapabilityType, readonly string[]>>;
  /** MoFlo integration level — controls access to memory, hooks, swarms, nested spells. */
  readonly mofloLevel?: MofloLevel;
  /**
   * Permission level for Claude CLI invocations spawned by this step.
   * Controls --allowedTools to enforce least-privilege:
   *   readonly   → Read,Glob,Grep
   *   standard   → Edit,Write,Read,Glob,Grep
   *   elevated   → Edit,Write,Bash,Read,Glob,Grep
   *   autonomous → no tool restriction (explicit opt-in only)
   * When omitted, derived automatically from the step's capabilities.
   */
  readonly permissionLevel?: PermissionLevel;
  /**
   * Declarative preflight checks run BEFORE step execution begins.
   * Each check runs a shell command; a check passes when exit code matches
   * `expectExitCode` (default 0). Variable interpolation in `command` is
   * resolved against spell args only (no prior step outputs yet).
   */
  readonly preflight?: readonly PreflightSpec[];
}

/**
 * Severity of a preflight failure.
 *   fatal   — always aborts the spell (default).
 *   warning — surfaces resolution options via the runner's warning handler.
 *             If no handler is configured (non-interactive run), warnings
 *             behave like fatals.
 */
export type PreflightSeverity = 'fatal' | 'warning';

/**
 * One user-pickable resolution for a failed warning preflight.
 * When the user selects a resolution, its optional `command` runs before
 * the spell proceeds; if the command fails, the spell aborts.
 */
export interface PreflightResolution {
  /** User-facing label (imperative, e.g. "Stash changes and continue"). */
  readonly label: string;
  /**
   * Shell command to run when the user picks this resolution.
   * Interpolated against spell args. If omitted, picking the resolution
   * proceeds without running anything — useful for "I'll handle it" opts.
   */
  readonly command?: string;
  /** Timeout in ms for the resolution command (default: 30_000). */
  readonly timeoutMs?: number;
}

/** Declarative preflight check in a step definition. */
export interface PreflightSpec {
  readonly name: string;
  readonly command: string;
  readonly expectExitCode?: number;
  readonly timeoutMs?: number;
  /**
   * Human-readable message shown to the user when this check fails.
   * Should explain the problem and how to fix it, in plain language
   * (no command names, exit codes, or tool jargon).
   * Example: "You have uncommitted changes. Commit or stash them first."
   */
  readonly hint?: string;
  /** Failure severity. Defaults to 'fatal'. */
  readonly severity?: PreflightSeverity;
  /**
   * Resolution options offered to the user when this warning fires.
   * Only relevant when severity is 'warning'.
   */
  readonly resolutions?: readonly PreflightResolution[];
}

// ============================================================================
// Spell Definition
// ============================================================================

export interface SpellDefinition {
  readonly name: string;
  readonly abbreviation?: string;
  readonly description?: string;
  readonly version?: string;
  readonly arguments?: Record<string, ArgumentDefinition>;
  readonly steps: readonly StepDefinition[];
  /** Default MoFlo integration level for all steps (can be narrowed per-step). */
  readonly mofloLevel?: MofloLevel;
  /** Schedule for automatic execution (cron, interval, or one-time). */
  readonly schedule?: ScheduleDefinition;
}

// ============================================================================
// Parsed Spell (with source metadata)
// ============================================================================

export interface ParsedSpell {
  readonly definition: SpellDefinition;
  readonly sourceFile?: string;
  readonly format: 'yaml' | 'json';
}
