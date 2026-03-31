/**
 * Epic Workflow Runner Adapter
 *
 * Bridges the CLI epic command to the workflow engine without direct
 * cross-package imports (avoids tsconfig rootDir issues).
 *
 * Story #197: Thin adapter for running workflow YAML from epic command.
 * Story #229: Uses shared engine loader instead of inline dynamic import.
 */

import { loadWorkflowEngine, type WorkflowResultLike } from '../services/engine-loader.js';

/** Minimal workflow result shape matching WorkflowResult from @claude-flow/workflows. */
export type EpicWorkflowResult = Pick<
  WorkflowResultLike,
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
  onStepComplete?: (step: { stepId: string; status: string; duration: number }, index: number, total: number) => void;
}

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
  const engine = await loadWorkflowEngine();
  return engine.runWorkflowFromContent(
    yamlContent,
    undefined,
    { ...options },
  ) as Promise<EpicWorkflowResult>;
}
