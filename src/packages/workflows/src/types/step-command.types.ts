/**
 * Workflow Step Command Type Definitions
 */

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: ValidationError[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

// ============================================================================
// JSON Schema (minimal subset for config validation)
// ============================================================================

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  // Numeric constraints
  minimum?: number;
  maximum?: number;
  // String constraints
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  // Array constraints
  minItems?: number;
  maxItems?: number;
  // Composition
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
}

// ============================================================================
// Step Configuration
// ============================================================================

export interface StepConfig {
  readonly [key: string]: unknown;
}

// ============================================================================
// Step Output
// ============================================================================

export interface StepOutput {
  readonly success: boolean;
  readonly data: Record<string, unknown>;
  readonly error?: string;
  readonly duration?: number;
}

export interface OutputDescriptor {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly description?: string;
  readonly required?: boolean;
}

// ============================================================================
// Workflow Context
// ============================================================================

export interface CredentialAccessor {
  get(name: string): Promise<string | undefined>;
  has(name: string): Promise<boolean>;
}

export interface MemoryAccessor {
  read(namespace: string, key: string): Promise<unknown | null>;
  write(namespace: string, key: string, value: unknown): Promise<void>;
  search(namespace: string, query: string): Promise<Array<{ key: string; value: unknown; score: number }>>;
}

export interface WorkflowContext {
  readonly variables: Record<string, unknown>;
  readonly args: Record<string, unknown>;
  readonly credentials: CredentialAccessor;
  readonly memory: MemoryAccessor;
  readonly taskId: string;
  readonly workflowId: string;
  readonly stepIndex: number;
  readonly abortSignal?: AbortSignal;
  /** Effective capabilities after merging command defaults with step restrictions. */
  readonly effectiveCaps?: readonly StepCapability[];
  /** Resolved MoFlo integration level for this step. */
  readonly mofloLevel?: MofloLevel;
  /** Nesting depth for recursive workflow invocations (0 = top-level). */
  readonly nestingDepth?: number;
  /** Maximum allowed nesting depth for recursive workflows. */
  readonly maxNestingDepth?: number;
}

// ============================================================================
// MoFlo Integration Levels
// ============================================================================

/**
 * Integration levels controlling access to MoFlo capabilities.
 * Ordered from least to most permissive (ordinal comparison).
 */
export type MofloLevel = 'none' | 'memory' | 'hooks' | 'full' | 'recursive';

/** Ordered list for ordinal comparison. */
export const MOFLO_LEVEL_ORDER: readonly MofloLevel[] = [
  'none', 'memory', 'hooks', 'full', 'recursive',
];

/** Default max nesting depth for recursive workflows. */
export const DEFAULT_MAX_NESTING_DEPTH = 3;

// ============================================================================
// Step Capabilities
// ============================================================================

/** Capability types that a step command may require. */
export type CapabilityType =
  | 'fs:read'
  | 'fs:write'
  | 'net'
  | 'shell'
  | 'memory'
  | 'credentials'
  | 'browser'
  | 'browser:evaluate'
  | 'agent';

/**
 * A capability declaration with optional scope restrictions.
 * E.g., `{ type: 'fs:read', scope: ['./config/'] }` limits reads to ./config/.
 */
export interface StepCapability {
  readonly type: CapabilityType;
  readonly scope?: readonly string[];
}

// ============================================================================
// Prerequisites
// ============================================================================

/**
 * A prerequisite that must be satisfied before a step command can execute.
 * E.g., `gh` CLI installed and authenticated, Playwright browsers available.
 */
export interface Prerequisite {
  readonly name: string;
  readonly check: () => Promise<boolean>;
  readonly installHint: string;
  readonly url?: string;
}

/** Result of checking a single prerequisite. */
export interface PrerequisiteResult {
  readonly name: string;
  readonly satisfied: boolean;
  readonly installHint: string;
  readonly url?: string;
}

// ============================================================================
// Step Command Interface
// ============================================================================

/**
 * Foundational abstraction for workflow steps.
 * Commands are stateless — all state flows through WorkflowContext.
 *
 * The generic parameter lets commands narrow their config type at compile time
 * while remaining registerable via the base `StepCommand` interface.
 */
export interface StepCommand<TConfig extends StepConfig = StepConfig> {
  readonly type: string;
  readonly description: string;
  readonly configSchema: JSONSchema;
  /** Capabilities this command requires by default. */
  readonly capabilities?: readonly StepCapability[];
  /** Default MoFlo integration level for this command type. */
  readonly defaultMofloLevel?: MofloLevel;
  /** External tool prerequisites required before this command can execute. */
  readonly prerequisites?: readonly Prerequisite[];

  /** Validate may be async (e.g. checking credentials or remote state). */
  validate(config: TConfig, context: WorkflowContext): ValidationResult | Promise<ValidationResult>;
  execute(config: TConfig, context: WorkflowContext): Promise<StepOutput>;
  describeOutputs(): OutputDescriptor[];
  rollback?(config: TConfig, context: WorkflowContext): Promise<void>;
}

// ============================================================================
// Registry Types
// ============================================================================

export interface StepCommandEntry {
  readonly command: StepCommand;
  readonly registeredAt: Date;
}
