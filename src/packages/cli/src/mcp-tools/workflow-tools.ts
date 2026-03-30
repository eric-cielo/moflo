/**
 * Workflow MCP Tools for CLI
 *
 * Wired to the real workflow engine via runner-bridge.ts.
 * Story #225: Replace mock file-based store with engine integration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MCPTool } from './types.js';

/** Walk up from cwd to find the nearest directory containing package.json or .git. */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(resolve(dir, 'package.json')) || existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return process.cwd(); // reached filesystem root
    dir = parent;
  }
}

// ============================================================================
// Engine Bridge (dynamic import to avoid cross-package static deps)
// ============================================================================

/** Resolved engine module — cached after first successful import. */
let engineModule: EngineModule | null = null;

interface EngineModule {
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

/** Minimal WorkflowResult shape to avoid direct type import. */
interface WorkflowResultLike {
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

interface WorkflowDefinitionLike {
  name: string;
  abbreviation?: string;
  description?: string;
  version?: string;
  arguments?: Record<string, unknown>;
  steps: readonly Record<string, unknown>[];
  mofloLevel?: string;
}

interface WorkflowRegistryLike {
  load(): { workflows: ReadonlyMap<string, { definition: WorkflowDefinitionLike; sourceFile: string; tier: string }>; errors: readonly { file: string; message: string }[] };
  resolve(query: string): { definition: WorkflowDefinitionLike; sourceFile: string; tier: string } | undefined;
  list(): readonly { name: string; abbreviation?: string; description?: string; tier: string }[];
  info(query: string): {
    name: string; abbreviation?: string; description?: string; version?: string;
    sourceFile: string; tier: string; arguments: Record<string, unknown>;
    stepCount: number; stepTypes: readonly string[];
  } | undefined;
}

async function getEngine(): Promise<EngineModule> {
  if (engineModule) return engineModule;

  try {
    // Resolve relative to this file's compiled location (same pattern as epic/runner-adapter.ts)
    const mod = await import(
      /* webpackIgnore: true */
      '../../../../packages/workflows/dist/index.js'
    );
    engineModule = mod as unknown as EngineModule;
    return engineModule;
  } catch {
    throw new Error(
      'Workflow engine not available. Run `npm run build` to compile the workflows package.',
    );
  }
}

// ============================================================================
// In-memory result tracking (for status queries between runs)
// ============================================================================

interface TrackedWorkflow {
  workflowId: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: WorkflowResultLike;
  startedAt: string;
  completedAt?: string;
}

const MAX_TRACKED = 100;
const trackedWorkflows = new Map<string, TrackedWorkflow>();

function evictOldest(): void {
  if (trackedWorkflows.size <= MAX_TRACKED) return;
  // Map iteration order is insertion order — delete the oldest
  const first = trackedWorkflows.keys().next().value;
  if (first) trackedWorkflows.delete(first);
}

function trackStart(workflowId: string, name: string, description?: string): TrackedWorkflow {
  const tracked: TrackedWorkflow = {
    workflowId,
    name,
    description,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  trackedWorkflows.set(workflowId, tracked);
  evictOldest();
  return tracked;
}

function trackResult(tracked: TrackedWorkflow, result: WorkflowResultLike): void {
  tracked.status = result.cancelled ? 'cancelled' : result.success ? 'completed' : 'failed';
  tracked.result = result;
  tracked.completedAt = new Date().toISOString();
}

/** Execute a definition via the engine with tracking and error handling. */
async function executeAndTrack(
  engine: EngineModule,
  definition: WorkflowDefinitionLike,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workflowId = `wf-${Date.now()}`;
  const tracked = trackStart(workflowId, definition.name, definition.description);

  try {
    const result = await engine.bridgeExecuteWorkflow(definition, args, { workflowId });
    trackResult(tracked, result);
    return serializeResult(result);
  } catch (err) {
    tracked.status = 'failed';
    tracked.completedAt = new Date().toISOString();
    return { workflowId, error: errorMsg(err) };
  }
}

// ============================================================================
// Registry singleton (created once per session)
// ============================================================================

let registryInstance: WorkflowRegistryLike | null = null;

async function getRegistry(): Promise<WorkflowRegistryLike> {
  if (registryInstance) return registryInstance;

  const engine = await getEngine();
  const shippedDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/workflows/definitions',
  );

  const projectRoot = findProjectRoot();
  registryInstance = new engine.WorkflowRegistry({
    shippedDir,
    userDirs: [
      resolve(projectRoot, 'workflows'),
      resolve(projectRoot, '.claude/workflows'),
    ],
  });

  return registryInstance;
}

// ============================================================================
// Serialization helpers
// ============================================================================

/** Extract error message from an unknown catch value. */
function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Serialize a single step for MCP responses. */
function serializeStep(s: WorkflowResultLike['steps'][number]) {
  return {
    stepId: s.stepId,
    stepType: s.stepType,
    status: s.status,
    duration: s.duration,
    error: s.error,
    errorCode: s.errorCode,
    outputData: s.output?.data,
  };
}

/** Count succeeded steps in a result. */
function countCompleted(result: WorkflowResultLike): number {
  return result.steps.filter(s => s.status === 'succeeded').length;
}

/** Serialize a WorkflowResult for MCP response (typed errors, step details). */
function serializeResult(result: WorkflowResultLike): Record<string, unknown> {
  return {
    workflowId: result.workflowId,
    success: result.success,
    cancelled: result.cancelled,
    duration: result.duration,
    stepCount: result.steps.length,
    steps: result.steps.map(serializeStep),
    outputs: result.outputs,
    errors: result.errors.map(e => ({
      stepId: e.stepId,
      code: e.code,
      message: e.message,
    })),
  };
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

export const workflowTools: MCPTool[] = [
  // --------------------------------------------------------------------------
  // workflow_run — Run a workflow from a file, registry name, or template
  // --------------------------------------------------------------------------
  {
    name: 'workflow_run',
    description: 'Run a workflow from a YAML/JSON file, registry name/abbreviation, or inline content',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name or abbreviation (resolved via registry)' },
        file: { type: 'string', description: 'Path to a YAML/JSON workflow definition file' },
        content: { type: 'string', description: 'Inline YAML/JSON workflow content' },
        args: { type: 'object', description: 'Arguments to pass to the workflow' },
        dryRun: { type: 'boolean', description: 'Validate without executing' },
      },
    },
    handler: async (input) => {
      const args = (input.args as Record<string, unknown>) ?? {};
      const dryRun = input.dryRun as boolean | undefined;

      if (input.name) {
        // Resolve via registry and execute the parsed definition directly
        const registry = await getRegistry();
        const loaded = registry.resolve(input.name as string);
        if (!loaded) {
          return { error: `Workflow not found in registry: ${input.name}` };
        }
        const engine = await getEngine();
        return executeAndTrack(engine, loaded.definition, args);
      }

      // Determine raw content source
      let content: string;
      let sourceFile: string | undefined;
      let workflowName: string;

      if (input.content) {
        content = input.content as string;
        workflowName = 'inline';
      } else if (input.file) {
        const filePath = resolve(findProjectRoot(), input.file as string);
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          return { error: `Workflow file not found or unreadable: ${filePath}` };
        }
        sourceFile = filePath;
        workflowName = String(input.file);
      } else {
        return { error: 'One of name, file, or content is required' };
      }

      // Run from raw content via bridge
      const engine = await getEngine();
      const result = await engine.bridgeRunWorkflow(content, sourceFile, args, { dryRun });
      const tracked = trackStart(result.workflowId, workflowName);
      trackResult(tracked, result);
      return serializeResult(result);
    },
  },

  // --------------------------------------------------------------------------
  // workflow_create — Create a workflow definition (returns parseable YAML)
  // --------------------------------------------------------------------------
  {
    name: 'workflow_create',
    description: 'Create a workflow definition from steps (returns YAML content)',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Workflow description' },
        steps: {
          type: 'array',
          description: 'Workflow steps',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              config: { type: 'object' },
            },
          },
        },
        arguments: { type: 'object', description: 'Workflow argument definitions' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const name = input.name as string;
      const description = input.description as string | undefined;
      const steps = (input.steps as Array<{ id?: string; type?: string; config?: Record<string, unknown> }>) ?? [];
      const args = input.arguments as Record<string, unknown> | undefined;

      // Build a WorkflowDefinition-compatible object
      const definition: WorkflowDefinitionLike = {
        name,
        description,
        arguments: args,
        steps: steps.map((s, i) => ({
          id: s.id ?? `step-${i + 1}`,
          type: s.type ?? 'bash',
          config: s.config ?? {},
        })),
      };

      return {
        name,
        description,
        stepCount: definition.steps.length,
        definition,
        message: 'Workflow definition created. Pass it to workflow_execute or workflow_run to run it.',
      };
    },
  },

  // --------------------------------------------------------------------------
  // workflow_execute — Execute a workflow definition directly
  // --------------------------------------------------------------------------
  {
    name: 'workflow_execute',
    description: 'Execute a workflow from a definition object',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        definition: { type: 'object', description: 'WorkflowDefinition object (from workflow_create or parsed YAML)' },
        args: { type: 'object', description: 'Runtime arguments' },
        dryRun: { type: 'boolean', description: 'Validate without executing' },
      },
      required: ['definition'],
    },
    handler: async (input) => {
      const definition = input.definition as WorkflowDefinitionLike;
      const args = (input.args as Record<string, unknown>) ?? {};

      if (!definition || !definition.name || !definition.steps) {
        return { error: 'Invalid definition: must have name and steps' };
      }

      if (input.dryRun) {
        const engine = await getEngine();
        const content = JSON.stringify(definition);
        const result = await engine.runWorkflowFromContent(content, undefined, {
          dryRun: true,
          args,
        });
        return serializeResult(result);
      }

      const engine = await getEngine();
      return executeAndTrack(engine, definition, args);
    },
  },

  // --------------------------------------------------------------------------
  // workflow_status — Get status of a tracked workflow
  // --------------------------------------------------------------------------
  {
    name: 'workflow_status',
    description: 'Get workflow execution status',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        verbose: { type: 'boolean', description: 'Include step details' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const workflowId = input.workflowId as string;
      const tracked = trackedWorkflows.get(workflowId);

      // Only check engine if it's already loaded (avoid unnecessary dynamic import)
      const isRunning = engineModule?.bridgeIsRunning(workflowId) ?? false;

      if (!tracked && !isRunning) {
        return { workflowId, error: 'Workflow not found' };
      }

      if (isRunning) {
        return {
          workflowId,
          status: 'running',
          name: tracked?.name,
          startedAt: tracked?.startedAt,
        };
      }

      if (!tracked) {
        return { workflowId, status: 'unknown' };
      }

      const response: Record<string, unknown> = {
        workflowId: tracked.workflowId,
        name: tracked.name,
        status: tracked.status,
        startedAt: tracked.startedAt,
        completedAt: tracked.completedAt,
      };

      if (tracked.result) {
        const completed = countCompleted(tracked.result);
        const total = tracked.result.steps.length;
        response.success = tracked.result.success;
        response.duration = tracked.result.duration;
        response.stepCount = total;
        response.completedSteps = completed;
        response.progress = total > 0 ? (completed / total) * 100 : 0;

        if (input.verbose) {
          response.steps = tracked.result.steps.map(serializeStep);
          response.errors = tracked.result.errors;
          response.outputs = tracked.result.outputs;
        }
      }

      return response;
    },
  },

  // --------------------------------------------------------------------------
  // workflow_list — List workflows from registry and tracked runs
  // --------------------------------------------------------------------------
  {
    name: 'workflow_list',
    description: 'List available workflows from registry and recent runs',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['registry', 'runs', 'all'], description: 'What to list (default: all)' },
        status: { type: 'string', description: 'Filter runs by status' },
        limit: { type: 'number', description: 'Max items to return' },
      },
    },
    handler: async (input) => {
      const source = (input.source as string) ?? 'all';
      const limit = (input.limit as number) ?? 20;
      const result: Record<string, unknown> = {};

      if (source === 'registry' || source === 'all') {
        try {
          const registry = await getRegistry();
          result.definitions = registry.list();
        } catch {
          result.definitions = [];
          result.registryError = 'Workflow engine not available';
        }
      }

      if (source === 'runs' || source === 'all') {
        let runs = [...trackedWorkflows.values()];
        if (input.status) {
          runs = runs.filter(r => r.status === input.status);
        }
        runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        result.runs = runs.slice(0, limit).map(r => ({
          workflowId: r.workflowId,
          name: r.name,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
        }));
      }

      // Also include currently running workflows from the engine
      try {
        const engine = await getEngine();
        result.activeWorkflows = engine.bridgeActiveWorkflows();
      } catch {
        result.activeWorkflows = [];
      }

      return result;
    },
  },

  // --------------------------------------------------------------------------
  // workflow_pause — Pause is not supported by the engine (workflows run to completion)
  // --------------------------------------------------------------------------
  {
    name: 'workflow_pause',
    description: 'Pause a running workflow (converts to cancel — engine workflows run to completion)',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const workflowId = input.workflowId as string;
      const engine = await getEngine();

      if (!engine.bridgeIsRunning(workflowId)) {
        return { workflowId, error: 'Workflow not running' };
      }

      // Engine doesn't support pause — cancel via AbortController
      const cancelled = engine.bridgeCancelWorkflow(workflowId);
      if (cancelled) {
        const tracked = trackedWorkflows.get(workflowId);
        if (tracked) {
          tracked.status = 'cancelled';
          tracked.completedAt = new Date().toISOString();
        }
      }

      return {
        workflowId,
        status: cancelled ? 'cancelled' : 'not_found',
        note: 'Engine workflows cannot be paused — cancelled instead. Use workflow_run to restart.',
      };
    },
  },

  // --------------------------------------------------------------------------
  // workflow_resume — Resume is not supported (re-run instead)
  // --------------------------------------------------------------------------
  {
    name: 'workflow_resume',
    description: 'Resume a workflow (re-runs from beginning — engine does not support mid-workflow resume)',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID of a previously tracked workflow' },
        args: { type: 'object', description: 'Override arguments for the re-run' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const workflowId = input.workflowId as string;
      const tracked = trackedWorkflows.get(workflowId);

      if (!tracked) {
        return { workflowId, error: 'Workflow not found in tracked runs' };
      }

      if (!tracked.result) {
        return { workflowId, error: 'No previous result to resume from' };
      }

      // Re-run the workflow from scratch
      // Note: The engine's runner supports initialVariables for paused-state resume,
      // but MCP tools don't currently persist paused definitions. This re-runs from start.
      return {
        workflowId,
        note: 'Mid-workflow resume is not yet supported via MCP tools. Use workflow_run to re-execute the workflow.',
        previousStatus: tracked.status,
        previousResult: {
          success: tracked.result.success,
          stepCount: tracked.result.steps.length,
          completedSteps: countCompleted(tracked.result),
        },
      };
    },
  },

  // --------------------------------------------------------------------------
  // workflow_cancel — Cancel a running workflow
  // --------------------------------------------------------------------------
  {
    name: 'workflow_cancel',
    description: 'Cancel a running workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        reason: { type: 'string', description: 'Cancellation reason' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const workflowId = input.workflowId as string;
      const engine = await getEngine();

      const cancelled = engine.bridgeCancelWorkflow(workflowId);

      if (cancelled) {
        const tracked = trackedWorkflows.get(workflowId);
        if (tracked) {
          tracked.status = 'cancelled';
          tracked.completedAt = new Date().toISOString();
        }
        return {
          workflowId,
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          reason: (input.reason as string) ?? 'Cancelled by user',
        };
      }

      // Check if it's a tracked but already finished workflow
      const tracked = trackedWorkflows.get(workflowId);
      if (tracked) {
        return { workflowId, error: `Workflow already ${tracked.status}` };
      }

      return { workflowId, error: 'Workflow not found' };
    },
  },

  // --------------------------------------------------------------------------
  // workflow_delete — Remove a tracked workflow from memory
  // --------------------------------------------------------------------------
  {
    name: 'workflow_delete',
    description: 'Delete a tracked workflow record',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      const workflowId = input.workflowId as string;

      // Only check engine if already loaded (avoid unnecessary dynamic import)
      if (engineModule?.bridgeIsRunning(workflowId)) {
        return { workflowId, error: 'Cannot delete a running workflow — cancel it first' };
      }

      const existed = trackedWorkflows.delete(workflowId);
      return {
        workflowId,
        deleted: existed,
        deletedAt: existed ? new Date().toISOString() : undefined,
      };
    },
  },

  // --------------------------------------------------------------------------
  // workflow_template — List/info from the workflow registry
  // --------------------------------------------------------------------------
  {
    name: 'workflow_template',
    description: 'Browse workflow templates from the registry',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info'], description: 'Template action' },
        query: { type: 'string', description: 'Workflow name or abbreviation (for info)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = input.action as string;

      if (action === 'list') {
        try {
          const registry = await getRegistry();
          const entries = registry.list();
          return {
            action,
            templates: entries,
            total: entries.length,
          };
        } catch (err) {
          return { action, error: errorMsg(err) };
        }
      }

      if (action === 'info') {
        const query = input.query as string;
        if (!query) {
          return { action, error: 'Query required for info action' };
        }
        try {
          const registry = await getRegistry();
          const info = registry.info(query);
          if (!info) {
            return { action, error: `Workflow not found: ${query}` };
          }
          return { action, ...info };
        } catch (err) {
          return { action, error: errorMsg(err) };
        }
      }

      return { action, error: `Unknown action: ${action}. Use 'list' or 'info'.` };
    },
  },
];
