/**
 * Workflow MCP Response Types
 *
 * Shared type definitions for workflow MCP tool responses.
 * Used by both the MCP tool handlers (workflow-tools.ts) and
 * the CLI workflow command (commands/workflow.ts) for type-safe
 * callMCPTool<T>() deserialization.
 *
 * Story #230: Extract shared workflow type definitions.
 */

/** Response from workflow_run / workflow_execute MCP tools. */
export interface WorkflowRunResponse {
  workflowId: string;
  success: boolean;
  cancelled: boolean;
  duration: number;
  stepCount: number;
  steps: WorkflowStepResponse[];
  outputs: Record<string, unknown>;
  errors: WorkflowErrorResponse[];
  error?: string;
}

/** Serialized step in a workflow MCP response. */
export interface WorkflowStepResponse {
  [key: string]: unknown;
  stepId: string;
  stepType: string;
  status: string;
  duration: number;
  error?: string;
  errorCode?: string;
  outputData?: unknown;
}

/** Serialized error in a workflow MCP response. */
export interface WorkflowErrorResponse {
  code: string;
  message: string;
  stepId?: string;
}

/** Response from workflow_status MCP tool. */
export interface WorkflowStatusResponse {
  workflowId: string;
  name?: string;
  status: string;
  success?: boolean;
  duration?: number;
  stepCount?: number;
  completedSteps?: number;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  steps?: WorkflowStepResponse[];
  errors?: WorkflowErrorResponse[];
  outputs?: Record<string, unknown>;
  error?: string;
}

/** Entry in a workflow registry list response. */
export interface WorkflowRegistryEntry {
  [key: string]: unknown;
  name: string;
  abbreviation?: string;
  description?: string;
  tier: string;
}

/** Response from workflow_list MCP tool. */
export interface WorkflowListResponse {
  definitions?: WorkflowRegistryEntry[];
  runs?: WorkflowRunEntry[];
  activeWorkflows?: string[];
  registryError?: string;
}

/** A tracked workflow run entry. */
export interface WorkflowRunEntry {
  [key: string]: unknown;
  workflowId: string;
  name: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

/** Response from workflow_cancel MCP tool. */
export interface WorkflowCancelResponse {
  workflowId: string;
  status: string;
  cancelledAt?: string;
  reason?: string;
  error?: string;
}

/** Response from workflow_template list action. */
export interface WorkflowTemplateListResponse {
  action: string;
  templates: WorkflowRegistryEntry[];
  total: number;
  error?: string;
}

/** Response from workflow_template info action. */
export interface WorkflowTemplateInfoResponse {
  action: string;
  name?: string;
  abbreviation?: string;
  description?: string;
  version?: string;
  sourceFile?: string;
  tier?: string;
  arguments?: Record<string, unknown>;
  stepCount?: number;
  stepTypes?: string[];
  error?: string;
}
