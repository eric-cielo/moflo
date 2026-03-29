/**
 * @claude-flow/workflows
 *
 * Generalized Workflow Engine for Claude Flow V3.
 *
 * Provides a pluggable, YAML/JSON-defined workflow system where every step type
 * implements a StepCommand interface — testable, reusable, and extensible.
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export type {
  StepCommand,
  StepConfig,
  StepOutput,
  StepCommandEntry,
  OutputDescriptor,
  ValidationResult,
  ValidationError,
  JSONSchema,
  WorkflowContext,
  CredentialAccessor,
  MemoryAccessor,
  StepCapability,
  CapabilityType,
  MofloLevel,
  Prerequisite,
  PrerequisiteResult,
} from './types/step-command.types.js';

export {
  MOFLO_LEVEL_ORDER,
  DEFAULT_MAX_NESTING_DEPTH,
} from './types/step-command.types.js';

export type {
  RunnerOptions,
  WorkflowResult,
  WorkflowError,
  WorkflowErrorCode,
  StepResult,
  StepStatus,
  DryRunResult,
  DryRunStepReport,
} from './types/runner.types.js';

// ============================================================================
// Core
// ============================================================================

export { StepCommandRegistry } from './core/step-command-registry.js';
export { WorkflowRunner } from './core/runner.js';
export { ToolAccessorImpl } from './core/tool-accessor.js';
export {
  checkCapabilities,
  type CapabilityViolation,
  type CapabilityCheckResult,
} from './core/capability-validator.js';
export {
  collectPrerequisites,
  checkPrerequisites,
  formatPrerequisiteErrors,
  commandExists,
} from './core/prerequisite-checker.js';

// ============================================================================
// Built-in Commands
// ============================================================================

export {
  agentCommand,
  bashCommand,
  conditionCommand,
  promptCommand,
  memoryCommand,
  waitCommand,
  loopCommand,
  browserCommand,
  githubCommand,
  builtinCommands,
} from './commands/index.js';

// ============================================================================
// Schema (Workflow Definition)
// ============================================================================

export type {
  WorkflowDefinition,
  StepDefinition,
  ArgumentDefinition,
  ArgumentType,
  ParsedWorkflow,
} from './types/workflow-definition.types.js';

export type {
  ScheduleDefinition,
} from './scheduler/schedule.types.js';

export { parseYaml, parseJson, parseWorkflow } from './schema/parser.js';
export { validateWorkflowDefinition, resolveArguments, type ValidatorOptions } from './schema/validator.js';

// ============================================================================
// Definition Loader (shipped + user override)
// ============================================================================

export {
  loadWorkflowDefinitions,
  loadWorkflowByName,
  type LoaderOptions,
  type LoadedWorkflow,
  type LoadResult,
  type LoadError,
} from './loaders/definition-loader.js';

// ============================================================================
// Runner Factory (MCP + CLI integration)
// ============================================================================

export {
  createRunner,
  runWorkflowFromContent,
  type RunnerFactoryOptions,
  type RunWorkflowOptions,
} from './factory/runner-factory.js';

export {
  bridgeRunWorkflow,
  bridgeExecuteWorkflow,
  bridgeCancelWorkflow,
  bridgeIsRunning,
  bridgeActiveWorkflows,
} from './factory/runner-bridge.js';

// ============================================================================
// Pause/Resume
// ============================================================================

export {
  buildPausedState,
  persistPausedState,
  resumeWorkflow,
  cleanupStalePaused,
  type PausedState,
  type ResumeOptions,
} from './factory/pause-resume.js';

// ============================================================================
// Credential Store
// ============================================================================

export {
  CredentialStore,
  CredentialStoreError,
  type CredentialMeta,
  type CredentialStoreOptions,
  type CredentialStoreErrorCode,
} from './credentials/credential-store.js';

// ============================================================================
// Workflow Registry (abbreviation lookup + list/info)
// ============================================================================

export {
  WorkflowRegistry,
  type RegistryOptions,
  type RegistryResult,
  type AbbreviationCollision,
  type WorkflowInfo,
  type WorkflowListEntry,
} from './registry/workflow-registry.js';

// ============================================================================
// Scheduler (cron, interval, one-time scheduling)
// ============================================================================

export {
  parseCron,
  parseInterval,
  parseAt,
  computeNextRun,
  nextRunFromCron,
  nextRunFromInterval,
  nextRunFromAt,
  validateSchedule,
  type ParsedCron,
  type NextRunInput,
} from './scheduler/cron-parser.js';

export {
  WorkflowScheduler,
  type WorkflowExecutor,
  type SchedulerEvent,
  type SchedulerEventType,
  type SchedulerListener,
} from './scheduler/scheduler.js';

export type {
  WorkflowSchedule,
  ScheduleExecution,
  SchedulerOptions,
} from './scheduler/schedule.types.js';

// ============================================================================
// Workflow Tools (external resource connectors)
// ============================================================================

export type {
  WorkflowTool,
  ToolView,
  ToolOutput,
  ToolAction,
  ToolCapability,
  ToolAccessor,
  ToolRegistryEntry,
  ToolSource,
} from './types/workflow-tool.types.js';

export {
  WorkflowToolRegistry,
  type ToolRegistryOptions,
  type ToolScanResult,
  type ToolScanError,
} from './registry/tool-registry.js';

// ============================================================================
// Built-in Tools
// ============================================================================

export {
  httpTool,
  builtinTools,
} from './tools/index.js';
