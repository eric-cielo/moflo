/**
 * Workflow Definition Types
 *
 * TypeScript types for YAML/JSON workflow definition files.
 */

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
}

// ============================================================================
// Workflow Definition
// ============================================================================

export interface WorkflowDefinition {
  readonly name: string;
  readonly abbreviation?: string;
  readonly description?: string;
  readonly version?: string;
  readonly arguments?: Record<string, ArgumentDefinition>;
  readonly steps: readonly StepDefinition[];
}

// ============================================================================
// Parsed Workflow (with source metadata)
// ============================================================================

export interface ParsedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly sourceFile?: string;
  readonly format: 'yaml' | 'json';
}
