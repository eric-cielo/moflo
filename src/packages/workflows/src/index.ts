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
} from './types/step-command.types.js';

// ============================================================================
// Core
// ============================================================================

export { StepCommandRegistry } from './core/step-command-registry.js';
export { interpolateString, interpolateConfig } from './core/interpolation.js';

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
  builtinCommands,
} from './commands/index.js';
