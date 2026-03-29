/**
 * Workflow Tool Type Definitions
 *
 * Tools are external resource connectors (HTTP, Gmail, Slack, etc.)
 * that step commands can consume via WorkflowContext dependency injection.
 */

import type { JSONSchema } from './step-command.types.js';

// ============================================================================
// Tool Output
// ============================================================================

export interface ToolOutput {
  readonly success: boolean;
  readonly data: Record<string, unknown>;
  readonly error?: string;
  readonly duration?: number;
}

// ============================================================================
// Tool Actions
// ============================================================================

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;
}

// ============================================================================
// Tool Capabilities
// ============================================================================

export type ToolCapability = 'read' | 'write' | 'search' | 'subscribe' | 'authenticate';

// ============================================================================
// Tool Accessor (DI interface for step commands)
// ============================================================================

/**
 * Read-only accessor passed to step commands via WorkflowContext.
 * Provides tool discovery and execution without exposing lifecycle methods.
 */
export interface ToolAccessor {
  get(name: string): WorkflowTool | undefined;
  has(name: string): boolean;
  list(): ReadonlyArray<{ name: string; description: string; capabilities: readonly ToolCapability[] }>;
  execute(toolName: string, action: string, params: Record<string, unknown>): Promise<ToolOutput>;
}

// ============================================================================
// Workflow Tool Interface
// ============================================================================

/**
 * Foundational abstraction for workflow tools.
 * Tools are stateless connectors — configuration flows through initialize(),
 * and runtime parameters flow through execute().
 *
 * Follows the same patterns as StepCommand: typed, capability-scoped,
 * with lifecycle hooks and self-describing actions.
 */
export interface WorkflowTool {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: readonly ToolCapability[];

  /** Initialize the tool with connection/auth config. */
  initialize(config: Record<string, unknown>): Promise<void>;

  /** Dispose of connections and resources. */
  dispose(): Promise<void>;

  /** Execute a named action with parameters. */
  execute(action: string, params: Record<string, unknown>): Promise<ToolOutput>;

  /** List all actions this tool supports, with input/output schemas. */
  listActions(): ToolAction[];
}

// ============================================================================
// Registry Types
// ============================================================================

export interface ToolRegistryEntry {
  readonly tool: WorkflowTool;
  readonly source: ToolSource;
  readonly registeredAt: Date;
}

export type ToolSource = 'shipped' | 'user' | 'npm';
