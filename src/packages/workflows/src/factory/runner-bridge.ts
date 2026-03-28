/**
 * Runner Bridge
 *
 * Provides a high-level, context-free API for MCP tool integration.
 * Each function is self-contained — no setup required. The bridge
 * creates runners on demand with built-in commands.
 *
 * This module is the integration point between MCP workflow tools
 * and the WorkflowRunner engine.
 */

import type { WorkflowResult } from '../types/runner.types.js';
import type { MemoryAccessor } from '../types/step-command.types.js';
import { createRunner, runWorkflowFromContent } from './runner-factory.js';

// Track active workflows for cancellation
const activeWorkflows = new Map<string, AbortController>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Run a workflow from raw file content (YAML/JSON).
 */
export async function bridgeRunWorkflow(
  content: string,
  sourceFile: string | undefined,
  args: Record<string, unknown>,
  options: { dryRun?: boolean; memory?: MemoryAccessor } = {},
): Promise<WorkflowResult> {
  const workflowId = `wf-${Date.now()}`;
  const controller = new AbortController();
  activeWorkflows.set(workflowId, controller);

  try {
    const result = await runWorkflowFromContent(content, sourceFile, {
      workflowId,
      args,
      dryRun: options.dryRun,
      signal: controller.signal,
      memory: options.memory,
    });
    return result;
  } finally {
    activeWorkflows.delete(workflowId);
  }
}

/**
 * Run a WorkflowDefinition directly (for workflow_execute).
 */
export async function bridgeExecuteWorkflow(
  definition: import('../types/workflow-definition.types.js').WorkflowDefinition,
  args: Record<string, unknown>,
  options: { workflowId?: string; memory?: MemoryAccessor } = {},
): Promise<WorkflowResult> {
  const workflowId = options.workflowId ?? `wf-${Date.now()}`;
  const controller = new AbortController();
  activeWorkflows.set(workflowId, controller);

  try {
    const runner = createRunner({ memory: options.memory });
    return await runner.run(definition, args, {
      workflowId,
      signal: controller.signal,
    });
  } finally {
    activeWorkflows.delete(workflowId);
  }
}

/**
 * Cancel a running workflow by ID.
 */
export function bridgeCancelWorkflow(workflowId: string): boolean {
  const controller = activeWorkflows.get(workflowId);
  if (!controller) return false;
  controller.abort();
  activeWorkflows.delete(workflowId);
  return true;
}

/**
 * Check if a workflow is currently running.
 */
export function bridgeIsRunning(workflowId: string): boolean {
  return activeWorkflows.has(workflowId);
}

/**
 * Get IDs of all currently running workflows.
 */
export function bridgeActiveWorkflows(): string[] {
  return [...activeWorkflows.keys()];
}
