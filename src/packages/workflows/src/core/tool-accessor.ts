/**
 * Tool Accessor
 *
 * Read-only accessor that wraps WorkflowToolRegistry for injection
 * into WorkflowContext. Provides tool discovery and execution without
 * exposing lifecycle methods (initialize/dispose).
 */

import type { ToolAccessor, ToolOutput, ToolCapability } from '../types/workflow-tool.types.js';
import type { WorkflowToolRegistry } from '../registry/tool-registry.js';

export class ToolAccessorImpl implements ToolAccessor {
  constructor(private readonly registry: WorkflowToolRegistry) {}

  get(name: string) {
    return this.registry.get(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  list(): ReadonlyArray<{ name: string; description: string; capabilities: readonly ToolCapability[] }> {
    return this.registry.list().map(entry => ({
      name: entry.tool.name,
      description: entry.tool.description,
      capabilities: entry.tool.capabilities,
    }));
  }

  async execute(toolName: string, action: string, params: Record<string, unknown>): Promise<ToolOutput> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        success: false,
        data: {},
        error: `Tool "${toolName}" not found in registry`,
      };
    }

    return tool.execute(action, params);
  }
}
