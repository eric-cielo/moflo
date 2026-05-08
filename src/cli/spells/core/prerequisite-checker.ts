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
import type { StepCommand, Prerequisite, PrerequisiteResult, CredentialAccessor } from '../types/step-command.types.js';
import type {
  SpellDefinition,
  StepDefinition,
  PrerequisiteSpec,
} from '../types/spell-definition.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';
import { acquireTTYLock } from './tty-lock.js';
import { readLineFromStdin } from './stdin-reader.js';

const execFileAsync = promisify(execFile);

/**
 * Check whether a CLI command is available on the system PATH.
 *
 * `timeoutMs` caps the lookup probe — important for callers that probe under
 * fork/GC pressure where `where`/`which` can stall (see platform-sandbox).
 */
export async function commandExists(cmd: string, opts?: { timeoutMs?: number }): Promise<boolean> {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(bin, [cmd], opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
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
    appendPrereqLine(lines, f.name, f.installHint, f.url);
  }
  return lines.join('\n');
}

function appendPrereqLine(
  lines: string[],
  name: string,
  hint: string | undefined,
  url: string | undefined,
): void {
  const hintSuffix = hint ? `: ${hint}` : '';
  lines.push(`  - ${name}${hintSuffix}`);
  if (url) lines.push(`    ${url}`);
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
  /**
   * Credential accessor consulted before prompting. When present and
   * `credentials.has(envKey)` is true, the resolver populates
   * `process.env[envKey]` from the store and skips the prompt.
   * When a TTY prompt produces answers, the resolver asks ONCE at the
   * end whether to persist them all to the store (default Y); on Y
   * each `envKey` is written via `credentials.store(envKey, value)`.
   */
  readonly credentials?: CredentialAccessor;
  /**
   * When true, skip the `credentials.get(envKey)` resolution step so every
   * env-type prereq goes through the interactive prompt — even when the
   * store already holds a value. Used to rotate or correct stored
   * credentials without manually deleting them first. Story #1002.
   */
  readonly forceCredentialReprompt?: boolean;
}

export interface ResolvePrerequisitesResult {
  readonly ok: boolean;
  /** Present when ok === false. Suitable for surfacing as a SpellError message. */
  readonly message?: string;
  /** Names of prereqs satisfied this call (from the store and/or prompt). */
  readonly resolvedNames: readonly string[];
  /**
   * `'MISSING_CREDENTIAL'` distinguishes "spell can't run unattended yet"
   * from generic preflight failure so the runner can surface a more
   * actionable error to schedulers.
   */
  readonly errorCode?: 'MISSING_CREDENTIAL';
  /** Env keys that were missing for the `MISSING_CREDENTIAL` path. */
  readonly missingCredentials?: readonly string[];
}

/**
 * Evaluate all prereqs. Resolution chain for env-type prereqs:
 *   1. process.env[key] already set → satisfied.
 *   2. credentials.get(key) returns a value → write to process.env, satisfied.
 *   3. TTY interactive → prompt → write to process.env. After ALL prompts,
 *      one Y/n offer asks whether to persist the collected answers to the
 *      credential store as a batch (default Y). Story #1002.
 *   4. Non-TTY or no credentials → fail fast with `errorCode: 'MISSING_CREDENTIAL'`.
 *
 * Non-env prereqs (`command`, `file`) bypass the credential chain and surface
 * through the standard "Missing prerequisites" path.
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
  const credentials = options.credentials;

  const initial = await checkPrerequisites(prerequisites);
  const unmetIndices = initial.flatMap((r, i) => r.satisfied ? [] : [i]);
  if (unmetIndices.length === 0) {
    return { ok: true, resolvedNames: [] };
  }

  // Pull env-type prereqs from the store in parallel — each resolved index
  // lets us skip a re-check of the cheap env detector.
  // `forceCredentialReprompt` bypasses this step so users can rotate or
  // correct stored credentials by re-running through the prompt path.
  const resolvedFromStoreNames: string[] = [];
  const storeResolved = new Set<number>();
  if (credentials && !options.forceCredentialReprompt) {
    await Promise.all(unmetIndices.map(async (i) => {
      const prereq = prerequisites[i];
      if (!prereq.envKey) return;
      const stored = await credentials.get(prereq.envKey);
      if (typeof stored === 'string' && stored.length > 0) {
        process.env[prereq.envKey] = stored;
        storeResolved.add(i);
        resolvedFromStoreNames.push(prereq.name);
      }
    }));
  }

  const stillUnmetIdx = unmetIndices.filter(i => !storeResolved.has(i));
  if (stillUnmetIdx.length === 0) {
    return { ok: true, resolvedNames: resolvedFromStoreNames };
  }

  const stillUnmet = stillUnmetIdx.map(i => prerequisites[i]);
  const promptable = stillUnmet.filter(
    p => interactive && p.promptOnMissing === true && typeof p.envKey === 'string',
  );

  if (!interactive || promptable.length === 0) {
    const promptableEnvKeys = stillUnmet
      .filter(p => p.promptOnMissing === true && typeof p.envKey === 'string')
      .map(p => p.envKey!);

    if (promptableEnvKeys.length > 0) {
      return {
        ok: false,
        message: formatMissingCredentialMessage(promptableEnvKeys, stillUnmet),
        resolvedNames: resolvedFromStoreNames,
        errorCode: 'MISSING_CREDENTIAL',
        missingCredentials: promptableEnvKeys,
      };
    }
    return {
      ok: false,
      message: formatPrerequisiteErrors(stillUnmetIdx.map(i => initial[i])),
      resolvedNames: resolvedFromStoreNames,
    };
  }

  printPreflightBanner(log, stillUnmet.length);

  const promptLine = options.promptLine ?? readLineFromStdin;
  const promptedNames: string[] = [];
  const promptableSet = new Set(promptable);
  const pendingSaves: Array<{ envKey: string; value: string }> = [];
  const lock = acquireTTYLock();
  let shouldSave = false;
  try {
    for (const prereq of promptable) {
      if (options.abortSignal?.aborted) {
        return {
          ok: false,
          message: 'Prerequisite resolution aborted',
          resolvedNames: [...resolvedFromStoreNames, ...promptedNames],
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
          resolvedNames: [...resolvedFromStoreNames, ...promptedNames],
        };
      }
      if (!answer || answer.length === 0) {
        return {
          ok: false,
          message: `Prerequisite "${prereq.name}" was not provided`,
          resolvedNames: [...resolvedFromStoreNames, ...promptedNames],
        };
      }
      if (prereq.envKey) {
        process.env[prereq.envKey] = answer;
        if (credentials) pendingSaves.push({ envKey: prereq.envKey, value: answer });
      }
      promptedNames.push(prereq.name);
    }

    // One batched save offer covers every collected answer — issuing N
    // confirmations would be repetitive when most users want all-or-nothing.
    if (credentials && pendingSaves.length > 0) {
      shouldSave = await promptSaveCredentialsConfirmation(
        promptLine, pendingSaves.length, options.abortSignal,
      );
    }
  } finally {
    lock.release();
  }

  // Persist outside the TTY lock so slow disk/keychain writes don't block
  // concurrent stdin readers waiting on the same lock.
  if (credentials && shouldSave) {
    for (const { envKey, value } of pendingSaves) {
      try {
        await credentials.store(envKey, value);
      } catch (err) {
        log(`  (could not persist credential "${envKey}": ${(err as Error).message})`);
      }
    }
  }

  // Anything in stillUnmet that wasn't promptable (typically command/file
  // prereqs) is still broken — carry forward the initial detector result.
  const unfixableIdx = stillUnmetIdx.filter(i => !promptableSet.has(prerequisites[i]));
  if (unfixableIdx.length > 0) {
    return {
      ok: false,
      message: formatPrerequisiteErrors(unfixableIdx.map(i => initial[i])),
      resolvedNames: [...resolvedFromStoreNames, ...promptedNames],
    };
  }
  return { ok: true, resolvedNames: [...resolvedFromStoreNames, ...promptedNames] };
}

function formatMissingCredentialMessage(
  envKeys: readonly string[],
  prereqs: readonly Prerequisite[],
): string {
  const lines = ['Missing credentials (cannot prompt — non-interactive run):'];
  for (const key of envKeys) {
    const prereq = prereqs.find(p => p.envKey === key);
    const label = `${prereq?.name ?? key} (${key})`;
    appendPrereqLine(lines, label, prereq?.installHint, prereq?.url);
  }
  lines.push('');
  lines.push('Prime these by casting the spell once interactively, or run:');
  lines.push('  flo spell credentials set <name>');
  return lines.join('\n');
}

/**
 * Ask once whether to persist every collected prereq answer to the
 * credential store. Empty input or `y/yes` → true (default Y); `n/no` →
 * false. A failed prompt (e.g. abort) silently declines so the cast
 * still proceeds with the in-memory env values.
 */
async function promptSaveCredentialsConfirmation(
  promptLine: PromptLineFn,
  count: number,
  abortSignal: AbortSignal | undefined,
): Promise<boolean> {
  const noun = count === 1 ? 'credential' : 'credentials';
  const prompt = `  Save ${count} ${noun} to the encrypted credential store for future runs? [Y/n] `;
  let answer: string;
  try {
    answer = await promptLine(prompt, abortSignal);
  } catch {
    return false;
  }
  const trimmed = answer.trim().toLowerCase();
  return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
}

function printPreflightBanner(log: (line: string) => void, unmetCount: number): void {
  log('');
  log('\x1b[1;36m━━━ Preflight: missing prerequisites ━━━\x1b[0m');
  log(`${unmetCount} prerequisite${unmetCount === 1 ? '' : 's'} need${unmetCount === 1 ? 's' : ''} a value before this spell can cast.`);
  log('');
}
