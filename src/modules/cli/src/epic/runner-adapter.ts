/**
 * Epic Workflow Runner Adapter
 *
 * Bridges the CLI epic command to the workflow engine without direct
 * cross-package imports (avoids tsconfig rootDir issues).
 *
 * Story #197: Thin adapter for running workflow YAML from epic command.
 * Story #229: Uses shared engine loader instead of inline dynamic import.
 */

import { loadSpellEngine, type WorkflowResult } from '../services/engine-loader.js';
import { createDashboardMemoryAccessor } from '../services/daemon-dashboard.js';

/** Minimal workflow result shape matching WorkflowResult from @moflo/spells. */
export type EpicWorkflowResult = Pick<
  WorkflowResult,
  'workflowId' | 'success' | 'outputs' | 'duration' | 'cancelled'
> & {
  steps: Array<{
    stepId: string;
    stepType: string;
    status: string;
    duration: number;
    error?: string;
  }>;
  errors: Array<{ code: string; message: string }>;
};

export interface EpicRunOptions {
  args?: Record<string, unknown>;
  dryRun?: boolean;
  onStepComplete?: (step: { stepId: string; status: string; duration: number; error?: string }, index: number, total: number) => void;
}

/** Cached memory accessor — created once per process. */
let memoryAccessor: Awaited<ReturnType<typeof createDashboardMemoryAccessor>> | null = null;

/**
 * Run a workflow YAML string via the workflow engine.
 *
 * Uses the shared engine loader (services/engine-loader.ts) which caches the
 * dynamically imported module. The workflows package must be built first.
 */
export async function runEpicWorkflow(
  yamlContent: string,
  options: EpicRunOptions = {},
): Promise<EpicWorkflowResult> {
  const engine = await loadSpellEngine();

  // Lazily initialize a real memory accessor so execution records
  // are persisted and visible in the dashboard.
  if (!memoryAccessor) {
    try {
      memoryAccessor = await createDashboardMemoryAccessor();
      console.log('[epic] Memory accessor ready — workflow progress will be persisted');
    } catch (err) {
      console.warn(`[epic] ⚠ Dashboard memory unavailable: ${(err as Error).message ?? err}`);
      console.warn('[epic] ⚠ Workflow executions will NOT appear in the dashboard');
    }
  }

  return engine.runWorkflowFromContent(
    yamlContent,
    undefined,
    { ...options, ...(memoryAccessor ? { memory: memoryAccessor } : {}) },
  ) as Promise<EpicWorkflowResult>;
}
