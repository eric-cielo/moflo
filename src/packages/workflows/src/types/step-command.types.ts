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
}

// ============================================================================
// Step Command Interface
// ============================================================================

/**
 * Foundational abstraction for workflow steps.
 * Commands are stateless — all state flows through WorkflowContext.
 */
export interface StepCommand {
  readonly type: string;
  readonly description: string;
  readonly configSchema: JSONSchema;

  /** Validate may be async (e.g. checking credentials or remote state). */
  validate(config: StepConfig, context: WorkflowContext): ValidationResult | Promise<ValidationResult>;
  execute(config: StepConfig, context: WorkflowContext): Promise<StepOutput>;
  describeOutputs(): OutputDescriptor[];
  rollback?(config: StepConfig, context: WorkflowContext): Promise<void>;
}

// ============================================================================
// Registry Types
// ============================================================================

export interface StepCommandEntry {
  readonly command: StepCommand;
  readonly registeredAt: Date;
}
