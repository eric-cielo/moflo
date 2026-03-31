/**
 * Workflow Connector Type Definitions
 *
 * Connectors are external resource bridges (HTTP, Gmail, Slack, etc.)
 * that step commands can consume via WorkflowContext dependency injection.
 */

import type { JSONSchema, StepOutput } from './step-command.types.js';

// ============================================================================
// Connector Output (structurally identical to StepOutput)
// ============================================================================

export type ConnectorOutput = StepOutput;

// ============================================================================
// Connector Actions
// ============================================================================

export interface ConnectorAction {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;
}

// ============================================================================
// Connector Capabilities
// ============================================================================

export type ConnectorCapability = 'read' | 'write' | 'search' | 'subscribe' | 'authenticate';

// ============================================================================
// Connector Accessor (DI interface for step commands)
// ============================================================================

/** Read-only view of a connector, excluding lifecycle methods (initialize/dispose). */
export type ConnectorView = Pick<WorkflowConnector, 'name' | 'description' | 'version' | 'capabilities' | 'listActions'>;

/**
 * Read-only accessor passed to step commands via WorkflowContext.
 * Provides connector discovery and execution without exposing lifecycle methods.
 */
export interface ConnectorAccessor {
  get(name: string): ConnectorView | undefined;
  has(name: string): boolean;
  list(): ReadonlyArray<{ name: string; description: string; capabilities: readonly ConnectorCapability[] }>;
  execute(connectorName: string, action: string, params: Record<string, unknown>): Promise<ConnectorOutput>;
}

// ============================================================================
// Workflow Connector Interface
// ============================================================================

/**
 * Foundational abstraction for workflow connectors.
 * Connectors are stateless bridges to external services — configuration flows
 * through initialize(), and runtime parameters flow through execute().
 *
 * Follows the same patterns as StepCommand: typed, capability-scoped,
 * with lifecycle hooks and self-describing actions.
 */
export interface WorkflowConnector {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: readonly ConnectorCapability[];

  /** Initialize the connector with connection/auth config. */
  initialize(config: Record<string, unknown>): Promise<void>;

  /** Dispose of connections and resources. */
  dispose(): Promise<void>;

  /** Execute a named action with parameters. */
  execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput>;

  /** List all actions this connector supports, with input/output schemas. */
  listActions(): ConnectorAction[];
}

// ============================================================================
// Registry Types
// ============================================================================

export interface ConnectorRegistryEntry {
  readonly connector: WorkflowConnector;
  readonly source: ConnectorSource;
  readonly registeredAt: Date;
}

export type ConnectorSource = 'shipped' | 'user' | 'npm';

// ============================================================================
