/**
 * Prerequisite Checker
 *
 * Collects prerequisites from three sources (declarative YAML at spell and
 * step level + imperative step-command-owned), dedupes by name, runs each
 * detector once, and — when stdin is a TTY — prompts for unmet env-type
 * prereqs and writes the answer into process.env so downstream steps
 * (including nested loop bodies) inherit it.
 *
 * Non-TTY failure path reports every unmet prereq with its docs URL so the
 * caller sees the full picture rather than failing mid-cast.
 *
 * Story #193: initial step-command-owned prereqs.
 * Issue #460: YAML-declared + interactive preflight walker.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { StepCommand, Prerequisite, PrerequisiteResult } from '../types/step-command.types.js';
import type {
  SpellDefinition,
  StepDefinition,
  PrerequisiteSpec,
} from '../types/spell-definition.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';
import { acquireTTYLock } from './tty-lock.js';
import { readLineFromStdin } from './stdin-reader.js';

const execFileAsync = promisify(execFile);

/** Check whether a CLI command is available on the system PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(bin, [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile a declarative YAML `PrerequisiteSpec` into the imperative
 * `Prerequisite` shape — synthesizes a `check()` that dispatches on the
 * detector type and populates the prompt-resolution metadata.
 */
export function compilePrerequisiteSpec(spec: PrerequisiteSpec): Prerequisite {
  const detect = spec.detect;
  const check = async (): Promise<boolean> => {
    switch (detect.type) {
      case 'env': {
        const val = process.env[detect.key];
        return typeof val === 'string' && val.length > 0;
      }
      case 'command':
        return commandExists(detect.command);
      case 'file':
        try {
          await access(detect.path);
          return true;
        } catch {
          return false;
        }
    }
  };

  const installHint = spec.description ?? defaultHintForDetect(spec);
  const envKey = detect.type === 'env' ? detect.key : undefined;
  const promptOnMissing = spec.promptOnMissing ?? true;

  return {
    name: spec.name,
    check,
    installHint,
    url: spec.docsUrl,
    description: spec.description,
    promptOnMissing,
    envKey,
  };
}

function defaultHintForDetect(spec: PrerequisiteSpec): string {
  switch (spec.detect.type) {
    case 'env': return `Set the ${spec.detect.key} environment variable`;
    case 'command': return `Install "${spec.detect.command}" and add it to your PATH`;
    case 'file': return `Ensure the file exists: ${spec.detect.path}`;
  }
}

/**
 * Collect unique prerequisites from a spell. Sources, in order:
 *   1. spell-level YAML (`definition.prerequisites`)
 *   2. step-level YAML (including nested loop/condition/parallel bodies)
 *   3. step-command built-ins (imperative, from the registry)
 *
 * Deduplicates by name — first occurrence wins.
 */
export function collectPrerequisites(
  definition: SpellDefinition,
  registry: StepCommandRegistry,
): Prerequisite[] {
  const seen = new Map<string, Prerequisite>();

  if (definition.prerequisites) {
    for (const spec of definition.prerequisites) {
      if (!seen.has(spec.name)) {
        seen.set(spec.name, compilePrerequisiteSpec(spec));
      }
    }
  }

  collectFromSteps(definition.steps, registry, seen);
  return Array.from(seen.values());
}

function collectFromSteps(
  steps: readonly StepDefinition[],
  registry: StepCommandRegistry,
  seen: Map<string, Prerequisite>,
): void {
  for (const step of steps) {
    if (step.prerequisites) {
      for (const spec of step.prerequisites) {
        if (!seen.has(spec.name)) {
          seen.set(spec.name, compilePrerequisiteSpec(spec));
        }
      }
    }

    const command: StepCommand | undefined = registry.get(step.type);
    if (command?.prerequisites) {
      for (const prereq of command.prerequisites) {
        if (!seen.has(prereq.name)) {
          seen.set(prereq.name, prereq);
        }
      }
    }

    if (step.steps && step.steps.length > 0) {
      collectFromSteps(step.steps, registry, seen);
    }
  }
}

/**
 * Run all prerequisite checks concurrently. Errors are treated as unsatisfied.
 */
export async function checkPrerequisites(
  prerequisites: readonly Prerequisite[],
): Promise<PrerequisiteResult[]> {
  return Promise.all(
    prerequisites.map(async (prereq) => {
      let satisfied = false;
      try {
        satisfied = await prereq.check();
      } catch {
        satisfied = false;
      }
      return {
        name: prereq.name,
        satisfied,
        installHint: prereq.installHint,
        url: prereq.url,
      };
    }),
  );
}

/**
 * Format failed prerequisites into a user-friendly error message.
 */
export function formatPrerequisiteErrors(results: readonly PrerequisiteResult[]): string {
  const failed = results.filter(r => !r.satisfied);
  if (failed.length === 0) return '';

  const lines = ['Missing prerequisites:'];
  for (const f of failed) {
    lines.push(`  - ${f.name}: ${f.installHint}`);
    if (f.url) lines.push(`    ${f.url}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Interactive resolution (TTY prompt + env write-back)
// ============================================================================

/** One-line reader, injectable for tests. */
export type PromptLineFn = (promptText: string, abortSignal?: AbortSignal) => Promise<string>;

export interface ResolvePrerequisitesOptions {
  /** Force interactive/non-interactive mode. Defaults to real stdin+stdout TTY. */
  readonly interactive?: boolean;
  readonly abortSignal?: AbortSignal;
  /** Injectable line reader for tests. Defaults to a readline-based stdin reader. */
  readonly promptLine?: PromptLineFn;
  /** Sink for preflight UI output. Defaults to console.log. */
  readonly log?: (line: string) => void;
}

export interface ResolvePrerequisitesResult {
  readonly ok: boolean;
  /** Present when ok === false. Suitable for surfacing as a SpellError message. */
  readonly message?: string;
  /** Names of prereqs that were prompted and resolved this call. */
  readonly resolvedNames: readonly string[];
}

/**
 * Evaluate all prereqs. On a TTY, prompts the user for unmet env-type prereqs
 * whose spec opted into `promptOnMissing`, writes answers into process.env,
 * then re-checks. Non-TTY calls and non-promptable unmet prereqs short-circuit
 * to a single formatted failure report.
 */
export async function resolveUnmetPrerequisites(
  prerequisites: readonly Prerequisite[],
  options: ResolvePrerequisitesOptions = {},
): Promise<ResolvePrerequisitesResult> {
  if (prerequisites.length === 0) {
    return { ok: true, resolvedNames: [] };
  }

  const interactive = options.interactive
    ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const log = options.log ?? ((line: string) => console.log(line));

  const initial = await checkPrerequisites(prerequisites);
  const unmet = prerequisites.filter((_, i) => !initial[i].satisfied);
  if (unmet.length === 0) {
    return { ok: true, resolvedNames: [] };
  }

  const promptable = unmet.filter(
    p => interactive && p.promptOnMissing === true && typeof p.envKey === 'string',
  );

  if (!interactive || promptable.length === 0) {
    return {
      ok: false,
      message: formatPrerequisiteErrors(initial),
      resolvedNames: [],
    };
  }

  printPreflightBanner(log, unmet.length);

  const promptLine = options.promptLine ?? readLineFromStdin;
  const resolvedNames: string[] = [];
  const lock = acquireTTYLock();
  try {
    for (const prereq of promptable) {
      if (options.abortSignal?.aborted) {
        return {
          ok: false,
          message: 'Prerequisite resolution aborted',
          resolvedNames,
        };
      }
      if (prereq.description) log(prereq.description);
      if (prereq.url) log(`  Docs: ${prereq.url}`);
      const prompt = `  ${prereq.name} > `;
      let answer: string;
      try {
        answer = await promptLine(prompt, options.abortSignal);
      } catch (err) {
        return {
          ok: false,
          message: `Prerequisite "${prereq.name}" prompt failed: ${(err as Error).message}`,
          resolvedNames,
        };
      }
      if (!answer || answer.length === 0) {
        return {
          ok: false,
          message: `Prerequisite "${prereq.name}" was not provided`,
          resolvedNames,
        };
      }
      if (prereq.envKey) {
        process.env[prereq.envKey] = answer;
      }
      resolvedNames.push(prereq.name);
    }
  } finally {
    lock.release();
  }

  // Re-check everything — any still unmet (e.g. command/file prereqs that
  // couldn't be resolved via prompt) fail now with the up-to-date report.
  const rerun = await checkPrerequisites(prerequisites);
  const stillUnmet = rerun.filter(r => !r.satisfied);
  if (stillUnmet.length > 0) {
    return {
      ok: false,
      message: formatPrerequisiteErrors(rerun),
      resolvedNames,
    };
  }
  return { ok: true, resolvedNames };
}

function printPreflightBanner(log: (line: string) => void, unmetCount: number): void {
  log('');
  log('\x1b[1;36m━━━ Preflight: missing prerequisites ━━━\x1b[0m');
  log(`${unmetCount} prerequisite${unmetCount === 1 ? '' : 's'} need${unmetCount === 1 ? 's' : ''} a value before this spell can cast.`);
  log('');
}
