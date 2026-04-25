/**
 * Preflight Checker
 *
 * Runs runtime-state validation BEFORE any step executes. Complements
 * prerequisite-checker.ts (static capability probes) by validating the
 * actual state each step depends on (e.g. issue is open, branch is clean).
 *
 * Two sources contribute preflights:
 *   1. Step commands may declare a `preflight` array on their interface —
 *      these run with the resolved step config + args.
 *   2. Step definitions may declare a YAML `preflight:` list of shell
 *      commands — these cover ad-hoc runtime checks for generic steps
 *      (e.g. a bash step that needs `git diff --quiet` first).
 *
 * All preflights for all steps run in parallel before step execution begins.
 * Any failure aborts the spell with a structured PRECHECK_FAILED error.
 */

import { execFile } from 'node:child_process';
import type {
  StepCommand,
  PreflightCheck,
  PreflightContext,
  PreflightResult,
  CredentialAccessor,
} from '../types/step-command.types.js';
import type {
  SpellDefinition,
  StepDefinition,
  PreflightSpec,
} from '../types/spell-definition.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';
import { interpolateString } from './interpolation.js';
import type { CastingContext } from '../types/step-command.types.js';
import type {
  PreflightSeverity,
  PreflightResolution,
} from '../types/spell-definition.types.js';

// ============================================================================
// Types
// ============================================================================

/** A preflight bound to a specific step in the spell. */
interface BoundPreflight {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly name: string;
  readonly severity: PreflightSeverity;
  readonly resolutions?: readonly PreflightResolution[];
  readonly run: () => Promise<{ passed: boolean; reason?: string }>;
}

export interface PreflightCollectionContext {
  readonly args: Record<string, unknown>;
  readonly credentials?: CredentialAccessor;
}

// ============================================================================
// Collection
// ============================================================================

/**
 * Collect every preflight that will run for this spell.
 * Walks every step, pulls both step-command preflights and YAML preflights,
 * and binds each with the step's own context/config.
 */
export function collectPreflights(
  definition: SpellDefinition,
  registry: StepCommandRegistry,
  context: PreflightCollectionContext,
): BoundPreflight[] {
  const out: BoundPreflight[] = [];
  collectFromSteps(definition.steps, registry, context, out, 0);
  return out;
}

function collectFromSteps(
  steps: readonly StepDefinition[],
  registry: StepCommandRegistry,
  context: PreflightCollectionContext,
  out: BoundPreflight[],
  startIndex: number,
): number {
  let index = startIndex;
  for (const step of steps) {
    const command: StepCommand | undefined = registry.get(step.type);

    // 1. Step-command preflights
    if (command?.preflight) {
      for (const check of command.preflight) {
        out.push(bindCommandPreflight(step, index, check, context));
      }
    }

    // 2. Declarative YAML preflights
    if (step.preflight) {
      for (const spec of step.preflight) {
        out.push(bindYamlPreflight(step, index, spec, context));
      }
    }

    // Recurse into nested steps (loops/conditions)
    if (step.steps && step.steps.length > 0) {
      index = collectFromSteps(step.steps, registry, context, out, index + 1);
    } else {
      index++;
    }
  }
  return index;
}

function bindCommandPreflight(
  step: StepDefinition,
  stepIndex: number,
  check: PreflightCheck,
  context: PreflightCollectionContext,
): BoundPreflight {
  return {
    stepId: step.id,
    stepIndex,
    name: check.name,
    severity: check.severity ?? 'fatal',
    resolutions: check.resolutions,
    run: () => {
      const ctx: PreflightContext = {
        args: context.args,
        credentials: context.credentials,
        stepId: step.id,
        stepIndex,
      };
      return check.check(step.config, ctx);
    },
  };
}

function bindYamlPreflight(
  step: StepDefinition,
  stepIndex: number,
  spec: PreflightSpec,
  context: PreflightCollectionContext,
): BoundPreflight {
  return {
    stepId: step.id,
    stepIndex,
    name: spec.name,
    severity: spec.severity ?? 'fatal',
    resolutions: spec.resolutions,
    run: async () => {
      const command = interpolateSafe(spec.command, context.args);
      const expected = spec.expectExitCode ?? 0;
      const timeoutMs = spec.timeoutMs ?? 10_000;
      const actualExitCode = await runShellExitCode(command, timeoutMs);
      if (actualExitCode === expected) return { passed: true };
      if (spec.hint) {
        return { passed: false, reason: spec.hint };
      }
      return {
        passed: false,
        reason: `command "${command}" exited with ${actualExitCode}, expected ${expected}`,
      };
    },
  };
}

// ============================================================================
// Execution
// ============================================================================

/** Run all preflights in parallel. Errors are treated as failures. */
export async function checkPreflights(
  preflights: readonly BoundPreflight[],
): Promise<PreflightResult[]> {
  return Promise.all(
    preflights.map(async (pf) => {
      try {
        const result = await pf.run();
        return {
          stepId: pf.stepId,
          name: pf.name,
          passed: result.passed,
          reason: result.reason,
          severity: pf.severity,
          resolutions: pf.resolutions,
        };
      } catch (err) {
        return {
          stepId: pf.stepId,
          name: pf.name,
          passed: false,
          reason: (err as Error).message,
          severity: pf.severity,
          resolutions: pf.resolutions,
        };
      }
    }),
  );
}

/**
 * Run a resolution shell command chosen by the user.
 * Returns true iff the command exits 0 (or no command was provided).
 */
export async function runResolutionCommand(
  resolution: PreflightResolution,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; exitCode: number }> {
  if (!resolution.command) return { ok: true, exitCode: 0 };
  const cmd = interpolateSafe(resolution.command, args);
  const exitCode = await runShellExitCode(cmd, resolution.timeoutMs ?? 30_000);
  return { ok: exitCode === 0, exitCode };
}

/** Format failed preflights into a user-friendly error message. */
export function formatPreflightErrors(results: readonly PreflightResult[]): string {
  const failed = results.filter(r => !r.passed);
  if (failed.length === 0) return '';

  const header = failed.length === 1
    ? 'A prerequisite for this spell was not met:'
    : `${failed.length} prerequisites for this spell were not met:`;
  const lines = [header];
  for (const f of failed) {
    const message = f.reason && f.reason.trim().length > 0 ? f.reason : f.name;
    lines.push(`  - ${message}`);
  }
  return lines.join('\n');
}

/** Partition preflight results by severity. */
export function partitionPreflightResults(
  results: readonly PreflightResult[],
): { fatals: readonly PreflightResult[]; warnings: readonly PreflightResult[] } {
  const fatals: PreflightResult[] = [];
  const warnings: PreflightResult[] = [];
  for (const r of results) {
    if (r.passed) continue;
    if (r.severity === 'warning') warnings.push(r);
    else fatals.push(r);
  }
  return { fatals, warnings };
}

// ============================================================================
// Internals
// ============================================================================

function interpolateSafe(template: string, args: Record<string, unknown>): string {
  try {
    const ctx = { args, variables: {} } as unknown as CastingContext;
    return interpolateString(template, ctx);
  } catch {
    return template;
  }
}

async function runShellExitCode(command: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = execFile(shell, shellArgs, { timeout: timeoutMs }, (err) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === 'number') {
        resolve((err as NodeJS.ErrnoException).code as unknown as number);
      } else if (err && (err as { signal?: string }).signal) {
        resolve(124); // timeout-ish
      }
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
