/**
 * @moflo/spells
 *
 * Generalized Spell Engine for MoFlo V4.
 *
 * Provides a pluggable, YAML/JSON-defined spell system where every step type
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
  StepCommandSource,
  OutputDescriptor,
  ValidationResult,
  ValidationError,
  JSONSchema,
  CastingContext,
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
  SpellResult,
  SpellError,
  SpellErrorCode,
  StepResult,
  StepStatus,
  DryRunResult,
  DryRunStepReport,
  FloRunContext,
} from './types/runner.types.js';

// ============================================================================
// Core
// ============================================================================

export { StepCommandRegistry } from './core/step-command-registry.js';
export { SpellCaster } from './core/runner.js';
export { ConnectorAccessorImpl } from './core/connector-accessor.js';
export { GatedConnectorAccessor } from './core/gated-connector-accessor.js';
export {
  checkCapabilities,
  type CapabilityViolation,
  type CapabilityCheckResult,
} from './core/capability-validator.js';
export {
  CapabilityGateway,
  CapabilityDeniedError,
  DenyAllGateway,
  DENY_ALL_GATEWAY,
  discloseStep,
  discloseSpell,
  formatStepDisclosure,
  formatSpellDisclosure,
  type ICapabilityGateway,
  type StepDisclosureSummary,
  type SpellDisclosureSummary,
} from './core/capability-gateway.js';
export {
  collectPrerequisites,
  checkPrerequisites,
  formatPrerequisiteErrors,
  commandExists,
} from './core/prerequisite-checker.js';

export {
  detectSandboxCapability,
  resetSandboxCache,
  resolveSandboxConfig,
  resolveEffectiveSandbox,
  formatSandboxLog,
  DEFAULT_SANDBOX_CONFIG,
  type SandboxCapability,
  type SandboxConfig,
  type SandboxTier,
  type SandboxOverhead,
  type EffectiveSandbox,
} from './core/platform-sandbox.js';

export {
  resolveScopePath,
  type SandboxWrapResult,
} from './core/sandbox-utils.js';

export {
  generateSandboxProfile,
  wrapWithSandboxExec,
} from './core/sandbox-profile.js';

export {
  buildBwrapArgs,
  wrapWithBwrap,
} from './core/bwrap-sandbox.js';

export {
  resolvePermissions,
  buildClaudeCommand,
  isValidPermissionLevel,
  VALID_PERMISSION_LEVELS,
  type PermissionLevel,
  type ResolvedPermissions,
} from './core/permission-resolver.js';

export {
  analyzeStepPermissions,
  analyzeSpellPermissions,
  formatStepPermissionReport,
  formatSpellPermissionReport,
  type StepPermissionReport,
  type SpellPermissionReport,
  type PermissionWarning,
  type RiskLevel,
} from './core/permission-disclosure.js';

export {
  recordAcceptance,
  checkAcceptance,
  clearAcceptance,
  type AcceptanceRecord,
  type AcceptanceCheckResult,
} from './core/permission-acceptance.js';

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
  parallelCommand,
  builtinCommands,
} from './commands/index.js';

export {
  createStepCommand,
  type StepCommandDefinition,
} from './commands/create-step-command.js';

// ============================================================================
// Schema (Spell Definition)
// ============================================================================

export type {
  SpellDefinition,
  StepDefinition,
  ArgumentDefinition,
  ArgumentType,
  ParsedSpell,
} from './types/spell-definition.types.js';

export type {
  ScheduleDefinition,
} from './scheduler/schedule.types.js';

export { parseYaml, parseJson, parseSpell } from './schema/parser.js';
export { validateSpellDefinition, resolveArguments, type ValidatorOptions } from './schema/validator.js';

// ============================================================================
// Definition Loader (shipped + user override)
// ============================================================================

export {
  loadSpellDefinitions,
  loadSpellByName,
  type LoaderOptions,
  type LoadedSpell,
  type LoadResult,
  type LoadError,
} from './loaders/definition-loader.js';

// ============================================================================
// Runner Factory (MCP + CLI integration)
// ============================================================================

export {
  createRunner,
  runSpellFromContent,
  type RunnerFactoryOptions,
  type RunSpellOptions,
} from './factory/runner-factory.js';

export {
  bridgeRunSpell,
  bridgeExecuteSpell,
  bridgeCancelSpell,
  bridgeIsRunning,
  bridgeActiveSpells,
} from './factory/runner-bridge.js';

// ============================================================================
// Pause/Resume
// ============================================================================

export {
  buildPausedState,
  persistPausedState,
  resumeSpell,
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
// Spell Registry (abbreviation lookup + list/info)
// ============================================================================

export {
  Grimoire,
  type RegistryOptions,
  type RegistryResult,
  type AbbreviationCollision,
  type SpellInfo,
  type SpellListEntry,
} from './registry/spell-registry.js';

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
  SpellScheduler,
  type SpellExecutor,
  type SchedulerEvent,
  type SchedulerEventType,
  type SchedulerListener,
} from './scheduler/scheduler.js';

export type {
  SpellSchedule,
  ScheduleExecution,
  SchedulerOptions,
} from './scheduler/schedule.types.js';

// ============================================================================
// Spell Connectors (external resource bridges)
// ============================================================================

export type {
  SpellConnector,
  ConnectorView,
  ConnectorOutput,
  ConnectorAction,
  ConnectorCapability,
  ConnectorAccessor,
  ConnectorRegistryEntry,
  ConnectorSource,
} from './types/spell-connector.types.js';

export {
  SpellConnectorRegistry,
  type ConnectorRegistryOptions,
  type ConnectorScanResult,
  type ConnectorScanError,
} from './registry/connector-registry.js';

// ============================================================================
// Built-in Connectors
// ============================================================================

export {
  httpConnector,
  githubCliConnector,
  playwrightConnector,
  builtinConnectors,
} from './connectors/index.js';
