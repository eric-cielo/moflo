/**
 * Shared Workflow Engine Loader
 *
 * Centralizes dynamic import + caching of the @claude-flow/workflows package.
 * Both workflow-tools.ts (MCP layer) and runner-adapter.ts (epic runner) use
 * this instead of maintaining their own import/cache logic.
 *
 * Story #229: Extract shared engine loader.
 */

// Minimal type shapes to avoid static cross-package dependency on @claude-flow/workflows.

export interface WorkflowResultLike {
  workflowId: string;
  success: boolean;
  steps: Array<{
    stepId: string;
    stepType: string;
    status: string;
    output?: { success: boolean; data?: unknown; error?: string };
    error?: string;
    errorCode?: string;
    duration: number;
  }>;
  outputs: Record<string, unknown>;
  errors: Array<{ stepId?: string; code: string; message: string; details?: unknown[] }>;
  duration: number;
  cancelled: boolean;
}

export interface WorkflowDefinitionLike {
  name: string;
  abbreviation?: string;
  description?: string;
  version?: string;
  arguments?: Record<string, unknown>;
  steps: readonly Record<string, unknown>[];
  mofloLevel?: string;
}

export interface WorkflowRegistryLike {
  load(): {
    workflows: ReadonlyMap<string, { definition: WorkflowDefinitionLike; sourceFile: string; tier: string }>;
    errors: readonly { file: string; message: string }[];
  };
  resolve(query: string): { definition: WorkflowDefinitionLike; sourceFile: string; tier: string } | undefined;
  list(): readonly { name: string; abbreviation?: string; description?: string; tier: string }[];
  info(query: string): {
    name: string; abbreviation?: string; description?: string; version?: string;
    sourceFile: string; tier: string; arguments: Record<string, unknown>;
    stepCount: number; stepTypes: readonly string[];
  } | undefined;
}

export interface EngineModule {
  bridgeRunWorkflow: (
    content: string,
    sourceFile: string | undefined,
    args: Record<string, unknown>,
    options?: { dryRun?: boolean },
  ) => Promise<WorkflowResultLike>;
  bridgeExecuteWorkflow: (
    definition: WorkflowDefinitionLike,
    args: Record<string, unknown>,
    options?: { workflowId?: string },
  ) => Promise<WorkflowResultLike>;
  bridgeCancelWorkflow: (workflowId: string) => boolean;
  bridgeIsRunning: (workflowId: string) => boolean;
  bridgeActiveWorkflows: () => string[];
  WorkflowRegistry: new (options?: Record<string, unknown>) => WorkflowRegistryLike;
  runWorkflowFromContent: (
    content: string,
    sourceFile: string | undefined,
    options?: Record<string, unknown>,
  ) => Promise<WorkflowResultLike>;
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
