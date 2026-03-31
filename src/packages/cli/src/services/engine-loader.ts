/**
 * Shared Workflow Engine Loader
 *
 * Centralizes dynamic import + caching of the @claude-flow/workflows package.
 * Both workflow-tools.ts (MCP layer) and runner-adapter.ts (epic runner) use
 * this instead of maintaining their own import/cache logic.
 *
 * Story #229: Extract shared engine loader.
 * Story #230: Replaced *Like interfaces with import type from @claude-flow/workflows.
 */

import type {
  WorkflowResult,
} from '../../../../packages/workflows/src/types/runner.types.js';
import type {
  WorkflowDefinition,
} from '../../../../packages/workflows/src/types/workflow-definition.types.js';
import type {
  WorkflowRegistry,
  RegistryOptions,
} from '../../../../packages/workflows/src/registry/workflow-registry.js';

// Re-export workflow types so consumers import from engine-loader (single boundary).
export type { WorkflowResult };
export type { WorkflowDefinition };
export type { WorkflowRegistry };

/**
 * Shape of the dynamically imported workflow engine module.
 *
 * Uses the canonical types from @claude-flow/workflows (type-only, no runtime dep).
 * The actual module is loaded via dynamic import() at runtime.
 */
export interface EngineModule {
  bridgeRunWorkflow: (
    content: string,
    sourceFile: string | undefined,
    args: Record<string, unknown>,
    options?: { dryRun?: boolean },
  ) => Promise<WorkflowResult>;
  bridgeExecuteWorkflow: (
    definition: WorkflowDefinition,
    args: Record<string, unknown>,
    options?: { workflowId?: string },
  ) => Promise<WorkflowResult>;
  bridgeCancelWorkflow: (workflowId: string) => boolean;
  bridgeIsRunning: (workflowId: string) => boolean;
  bridgeActiveWorkflows: () => string[];
  WorkflowRegistry: new (options?: RegistryOptions) => WorkflowRegistry;
  runWorkflowFromContent: (
    content: string,
    sourceFile: string | undefined,
    options?: Record<string, unknown>,
  ) => Promise<WorkflowResult>;
}

let cachedEngine: EngineModule | null = null;
let pendingImport: Promise<EngineModule> | null = null;

/**
 * Dynamically import the workflow engine, caching after first successful load.
 * Uses a pending-promise guard to prevent duplicate imports under concurrency.
 */
export async function loadWorkflowEngine(): Promise<EngineModule> {
  if (cachedEngine) return cachedEngine;
  if (pendingImport) return pendingImport;

  pendingImport = (async () => {
    try {
      const mod = await import(
        /* webpackIgnore: true */
        '../../../../packages/workflows/dist/index.js'
      );
      cachedEngine = mod as unknown as EngineModule;
      return cachedEngine;
    } catch {
      throw new Error(
        'Workflow engine not available. Run `npm run build` to compile the workflows package.',
      );
    } finally {
      pendingImport = null;
    }
  })();

  return pendingImport;
}

/**
 * Return the cached engine module if already loaded, or null.
 * Useful for non-critical checks that should not trigger a dynamic import.
 */
export function getCachedEngine(): EngineModule | null {
  return cachedEngine;
}
