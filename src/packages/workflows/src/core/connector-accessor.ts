/**
 * Connector Accessor
 *
 * Read-only accessor that wraps WorkflowConnectorRegistry for injection
 * into WorkflowContext. Provides connector discovery and execution without
 * exposing lifecycle methods (initialize/dispose).
 */

import type { ConnectorAccessor, ConnectorView, ConnectorOutput, ConnectorCapability } from '../types/workflow-connector.types.js';
import type { WorkflowConnectorRegistry } from '../registry/connector-registry.js';

export class ConnectorAccessorImpl implements ConnectorAccessor {
  private readonly initialized = new Set<string>();

  constructor(private readonly registry: WorkflowConnectorRegistry) {}

  get(name: string): ConnectorView | undefined {
    const connector = this.registry.get(name);
    if (!connector) return undefined;
    // Return a narrow view excluding lifecycle methods
    return {
      name: connector.name,
      description: connector.description,
      version: connector.version,
      capabilities: connector.capabilities,
      listActions: connector.listActions.bind(connector),
    };
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  list(): ReadonlyArray<{ name: string; description: string; capabilities: readonly ConnectorCapability[] }> {
    return this.registry.list().map(entry => ({
      name: entry.connector.name,
      description: entry.connector.description,
      capabilities: entry.connector.capabilities,
    }));
  }

  async execute(connectorName: string, action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
    const connector = this.registry.get(connectorName);
    if (!connector) {
      return {
        success: false,
        data: {},
        error: `Connector "${connectorName}" not found in registry`,
      };
    }

    // Lazy initialization: initialize on first execute() call per connector
    if (!this.initialized.has(connectorName)) {
      try {
        await connector.initialize({});
        this.initialized.add(connectorName);
      } catch (err) {
        return {
          success: false,
          data: {},
          error: `Connector "${connectorName}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return connector.execute(action, params);
  }

  /** Dispose all initialized connectors in parallel. Errors are swallowed (best-effort). */
  async disposeAll(): Promise<void> {
    if (this.initialized.size === 0) return;
    await Promise.allSettled(
      [...this.initialized].map(async (name) => {
        const connector = this.registry.get(name);
        if (connector) await connector.dispose();
      }),
    );
    this.initialized.clear();
  }
}
