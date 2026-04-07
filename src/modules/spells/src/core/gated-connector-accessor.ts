/**
 * Gated Connector Accessor
 *
 * Issue #265: Wraps a ConnectorAccessor with CapabilityGateway enforcement.
 * Every execute() call passes through gateway.checkNet() before delegation,
 * closing the ungated I/O path through connectors.
 */

import type { ConnectorAccessor, ConnectorView, ConnectorOutput, ConnectorCapability } from '../types/workflow-connector.types.js';
import type { ICapabilityGateway } from './capability-gateway.js';

export class GatedConnectorAccessor implements ConnectorAccessor {
  constructor(
    private readonly inner: ConnectorAccessor,
    private readonly gateway: ICapabilityGateway,
  ) {}

  get(name: string): ConnectorView | undefined {
    return this.inner.get(name);
  }

  has(name: string): boolean {
    return this.inner.has(name);
  }

  list(): ReadonlyArray<{ name: string; description: string; capabilities: readonly ConnectorCapability[] }> {
    return this.inner.list();
  }

  async execute(connectorName: string, action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
    // Connectors are external resource bridges — enforce net capability before any I/O
    try {
      this.gateway.checkNet(connectorName);
    } catch (err) {
      return {
        success: false,
        data: {},
        error: `Connector "${connectorName}" blocked by capability gateway: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return this.inner.execute(connectorName, action, params);
  }
}
