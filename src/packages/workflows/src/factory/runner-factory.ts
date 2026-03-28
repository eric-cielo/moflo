/**
 * Runner Factory
 *
 * Creates a fully configured WorkflowRunner with the built-in command registry,
 * credentials, and memory accessors. Provides a high-level API for MCP tool
 * integration and CLI usage.
 */

import type { CredentialAccessor, MemoryAccessor } from '../types/step-command.types.js';
import type { WorkflowDefinition } from '../types/workflow-definition.types.js';
import type { RunnerOptions, WorkflowResult } from '../types/runner.types.js';
import { StepCommandRegistry } from '../core/step-command-registry.js';
import { WorkflowRunner } from '../core/runner.js';
import { builtinCommands } from '../commands/index.js';
import { parseWorkflow } from '../schema/parser.js';
import { validateWorkflowDefinition } from '../schema/validator.js';

// ============================================================================
// Types
// ============================================================================

export interface RunnerFactoryOptions {
  readonly credentials?: CredentialAccessor;
  readonly memory?: MemoryAccessor;
}

export interface RunWorkflowOptions extends RunnerOptions {
  /** Arguments to pass to the workflow. */
  readonly args?: Record<string, unknown>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a WorkflowRunner with built-in commands registered.
 */
export function createRunner(options: RunnerFactoryOptions = {}): WorkflowRunner {
  const registry = new StepCommandRegistry();
  for (const cmd of builtinCommands) {
    registry.register(cmd);
  }

  const credentials = options.credentials ?? noopCredentials;
  const memory = options.memory ?? noopMemory;

  return new WorkflowRunner(registry, credentials, memory);
}

/**
 * Parse, validate, and run a workflow from raw YAML/JSON content.
 * Returns a structured result — never throws.
 */
export async function runWorkflowFromContent(
  content: string,
  sourceFile: string | undefined,
  options: RunWorkflowOptions & RunnerFactoryOptions = {},
): Promise<WorkflowResult> {
  let definition: WorkflowDefinition;
  try {
    const parsed = parseWorkflow(content, sourceFile);
    definition = parsed.definition;
  } catch (err) {
    return {
      workflowId: options.workflowId ?? `wf-${Date.now()}`,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'DEFINITION_VALIDATION_FAILED', message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }],
      duration: 0,
      cancelled: false,
    };
  }

  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) {
    return {
      workflowId: options.workflowId ?? `wf-${Date.now()}`,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'DEFINITION_VALIDATION_FAILED', message: validation.errors.map(e => e.message).join('; ') }],
      duration: 0,
      cancelled: false,
    };
  }

  const runner = createRunner(options);
  const { args = {}, ...runnerOptions } = options;
  return runner.run(definition, args, runnerOptions);
}

// ============================================================================
// Noop Accessors (for standalone usage without full CLI context)
// ============================================================================

const noopCredentials: CredentialAccessor = {
  async get() { return undefined; },
  async has() { return false; },
};

const noopMemory: MemoryAccessor = {
  async read() { return null; },
  async write() { /* noop */ },
  async search() { return []; },
};
