/**
 * Epic Workflow Runner Adapter
 *
 * Bridges the CLI epic command to the workflow engine without direct
 * cross-package imports (avoids tsconfig rootDir issues).
 *
 * Story #197: Thin adapter for running workflow YAML from epic command.
 */

/** Minimal workflow result shape matching WorkflowResult from @claude-flow/workflows. */
export interface EpicWorkflowResult {
  workflowId: string;
  success: boolean;
  steps: Array<{
    stepId: string;
    stepType: string;
    status: string;
    duration: number;
    error?: string;
  }>;
  outputs: Record<string, unknown>;
  errors: Array<{ code: string; message: string }>;
  duration: number;
  cancelled: boolean;
}

export interface EpicRunOptions {
  args?: Record<string, unknown>;
  dryRun?: boolean;
  onStepComplete?: (step: { stepId: string; status: string; duration: number }, index: number, total: number) => void;
}

/**
 * Run a workflow YAML string via the workflow engine.
 *
 * Dynamically imports the workflows package to avoid static cross-package
 * dependency issues. The workflows package must be built first.
 */
export async function runEpicWorkflow(
  yamlContent: string,
  _sourceFile: string | undefined,
  options: EpicRunOptions = {},
): Promise<EpicWorkflowResult> {
  // Dynamic import of the workflow engine
  const { runWorkflowFromContent } = await import(
    /* webpackIgnore: true */
    '../../../../packages/workflows/dist/index.js'
  );

  return runWorkflowFromContent(yamlContent, _sourceFile, options);
}
