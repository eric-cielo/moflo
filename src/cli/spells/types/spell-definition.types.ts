/**
 * Spell Definition Types
 *
 * TypeScript types for YAML/JSON spell definition files.
 */

import type { CapabilityType, MofloLevel } from './step-command.types.js';
import type { PermissionLevel } from '../core/permission-resolver.js';
import type { ScheduleDefinition } from '../scheduler/schedule.types.js';

// ============================================================================
// Argument Definitions
// ============================================================================

export type ArgumentType = 'string' | 'number' | 'boolean' | 'string[]';

export interface ArgumentDefinition {
  readonly type: ArgumentType;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly description?: string;
}

// ============================================================================
// Step Definitions
// ============================================================================

export interface StepDefinition {
  readonly id: string;
  readonly type: string;
  readonly config: Record<string, unknown>;
  readonly output?: string;
  readonly continueOnError?: boolean;
  /** Nested steps for condition/loop commands. */
  readonly steps?: readonly StepDefinition[];
  /** Capability restrictions for this step (narrows the command's defaults). */
  readonly capabilities?: Partial<Record<CapabilityType, readonly string[]>>;
  /** MoFlo integration level — controls access to memory, hooks, swarms, nested spells. */
  readonly mofloLevel?: MofloLevel;
  /**
   * Permission level for Claude CLI invocations spawned by this step.
   * Controls --allowedTools to enforce least-privilege:
   *   readonly   → Read,Glob,Grep
   *   standard   → Edit,Write,Read,Glob,Grep
   *   elevated   → Edit,Write,Bash,Read,Glob,Grep
   *   autonomous → no tool restriction (explicit opt-in only)
   * When omitted, derived automatically from the step's capabilities.
   */
  readonly permissionLevel?: PermissionLevel;
  /**
   * Declarative preflight checks run BEFORE step execution begins.
   * Each check runs a shell command; a check passes when exit code matches
   * `expectExitCode` (default 0). Variable interpolation in `command` is
   * resolved against spell args only (no prior step outputs yet).
   */
  readonly preflight?: readonly PreflightSpec[];
  /**
   * Declarative prerequisites required for this step (env vars, CLI binaries,
   * files). Collected at cast time across the whole spell tree (including
   * nested loop/condition/parallel bodies) and evaluated before step 1.
   */
  readonly prerequisites?: readonly PrerequisiteSpec[];
}

/**
 * Severity of a preflight failure.
 *   fatal   — always aborts the spell (default).
 *   warning — surfaces resolution options via the runner's warning handler.
 *             If no handler is configured (non-interactive run), warnings
 *             behave like fatals.
 */
export type PreflightSeverity = 'fatal' | 'warning';

/**
 * One user-pickable resolution for a failed warning preflight.
 * When the user selects a resolution, its optional `command` runs before
 * the spell proceeds; if the command fails, the spell aborts.
 */
export interface PreflightResolution {
  /** User-facing label (imperative, e.g. "Stash changes and continue"). */
  readonly label: string;
  /**
   * Shell command to run when the user picks this resolution.
   * Interpolated against spell args. If omitted, picking the resolution
   * proceeds without running anything — useful for "I'll handle it" opts.
   */
  readonly command?: string;
  /** Timeout in ms for the resolution command (default: 30_000). */
  readonly timeoutMs?: number;
}

// ============================================================================
// Prerequisite Specs (declarative, YAML-authored)
// ============================================================================
//
// Distinct from the imperative step-command-owned `Prerequisite` (which carries
// a `check()` callback) and the step-level `PreflightSpec` (runtime state
// checks via shell command). A `PrerequisiteSpec` is a declarative, detector-
// based description of an external dependency (env var, CLI binary, file).
// Collected at cast time, compiled into the imperative `Prerequisite` shape,
// and evaluated BEFORE step 1. When unmet on a TTY, the engine prompts once
// per prereq (env-type writes the answer to `process.env`).

/** Detector discriminator — how to check whether a prerequisite is satisfied. */
export type PrerequisiteDetect =
  /** Satisfied when `process.env[key]` is set to a non-empty string. */
  | { readonly type: 'env'; readonly key: string }
  /** Satisfied when `command` is resolvable on the system PATH. */
  | { readonly type: 'command'; readonly command: string }
  /** Satisfied when `path` exists on disk. */
  | { readonly type: 'file'; readonly path: string };

/**
 * Expected value format for a stored credential. Lets the resolver shape-check
 * the value pulled from the credential store before promoting it to
 * `process.env`, so a malformed value re-prompts instead of being silently
 * fed to the spell.
 *
 *   - `'jwt'`: must be three non-empty base64url segments separated by `.`,
 *     and (if an `exp` claim is present) not expired.
 *
 * Story #1009: extends #1007 to catch values that aren't even JWT-shaped
 * (e.g. opaque strings stored under a key that requires a JWT).
 */
export type PrerequisiteFormat = 'jwt';

/** YAML-declared prerequisite on a spell or step. */
export interface PrerequisiteSpec {
  /** Stable name used for dedupe across spell + step + built-in sources. */
  readonly name: string;
  /** Short human-readable explanation shown when the prereq is unmet. */
  readonly description?: string;
  /** Link to setup docs, shown alongside the description in preflight output. */
  readonly docsUrl?: string;
  /** How to detect whether this prereq is satisfied. */
  readonly detect: PrerequisiteDetect;
  /**
   * When true and stdin+stdout are a TTY, prompt the user for the value when
   * unmet. For `env`-type prereqs the answer is written to `process.env[key]`
   * so downstream steps (including nested loop bodies) can read it directly.
   * For `command`/`file` types the prompt surfaces guidance only (no write-back).
   * Defaults to `true`.
   */
  readonly promptOnMissing?: boolean;
  /**
   * Declared format for env-type values. When set, stored values pulled from
   * the credential store must match the declared shape or the resolver
   * rejects them and re-prompts. Authors set this on prereqs whose API
   * contract is unambiguous (e.g. Microsoft Graph `_ACCESS_TOKEN` is always
   * a JWT). Without it, validation falls back to the conservative shape
   * heuristics in `validateStoredCredential`.
   */
  readonly format?: PrerequisiteFormat;
}

/** Declarative preflight check in a step definition. */
export interface PreflightSpec {
  readonly name: string;
  readonly command: string;
  readonly expectExitCode?: number;
  readonly timeoutMs?: number;
  /**
   * Human-readable message shown to the user when this check fails.
   * Should explain the problem and how to fix it, in plain language
   * (no command names, exit codes, or tool jargon).
   * Example: "You have uncommitted changes. Commit or stash them first."
   */
  readonly hint?: string;
  /** Failure severity. Defaults to 'fatal'. */
  readonly severity?: PreflightSeverity;
  /**
   * Resolution options offered to the user when this warning fires.
   * Only relevant when severity is 'warning'.
   */
  readonly resolutions?: readonly PreflightResolution[];
}

// ============================================================================
// Sandbox Requirement
// ============================================================================

/**
 * Per-spell sandboxing requirement. Composes with the global `sandbox` block
 * in `moflo.yaml` under "more strict wins": either source can opt in to OS
 * sandboxing, neither can opt out of what the other requires.
 *
 * @see https://github.com/eric-cielo/moflo/issues/878
 */
export interface SandboxRequirement {
  /**
   * When true, the runner refuses to cast this spell unless the effective
   * sandbox is active (`useOsSandbox: true`). Default: false.
   */
  readonly required?: boolean;
}

// ============================================================================
// Spell Definition
// ============================================================================

export interface SpellDefinition {
  readonly name: string;
  readonly abbreviation?: string;
  readonly description?: string;
  readonly version?: string;
  readonly arguments?: Record<string, ArgumentDefinition>;
  readonly steps: readonly StepDefinition[];
  /** Default MoFlo integration level for all steps (can be narrowed per-step). */
  readonly mofloLevel?: MofloLevel;
  /** Schedule for automatic execution (cron, interval, or one-time). */
  readonly schedule?: ScheduleDefinition;
  /**
   * Declarative prerequisites required for this spell (env vars, CLI binaries,
   * files). Evaluated before step 1; missing env prereqs on a TTY trigger an
   * interactive prompt. See `PrerequisiteSpec` for detector details.
   */
  readonly prerequisites?: readonly PrerequisiteSpec[];
  /**
   * Per-spell sandbox requirement. When `sandbox.required` is true, the runner
   * refuses to cast unless the effective sandbox is active. Composes with the
   * global `sandbox` config in `moflo.yaml` under "more strict wins".
   */
  readonly sandbox?: SandboxRequirement;
}

// ============================================================================
// Parsed Spell (with source metadata)
// ============================================================================

export interface ParsedSpell {
  readonly definition: SpellDefinition;
  readonly sourceFile?: string;
  readonly format: 'yaml' | 'json';
}
