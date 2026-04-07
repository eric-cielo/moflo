/**
 * Workflow Definition Types
 *
 * TypeScript types for YAML/JSON workflow definition files.
 */

import type { CapabilityType, MofloLevel } from './step-command.types.js';
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
  /** MoFlo integration level — controls access to memory, hooks, swarms, nested workflows. */
  readonly mofloLevel?: MofloLevel;
}

// ============================================================================
// Workflow Definition
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
// Parsed Workflow (with source metadata)
// ============================================================================

export interface ParsedWorkflow {
  readonly definition: SpellDefinition;
  readonly sourceFile?: string;
  readonly format: 'yaml' | 'json';
}
