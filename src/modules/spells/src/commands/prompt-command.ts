/**
 * Prompt Step Command — asks the user a question.
 *
 * When stdin is a TTY, reads an interactive line of input via readline.
 * When stdin is not a TTY (CI, subprocess, tests), returns the effective
 * default so spells remain non-interactive and reproducible.
 *
 * Default resolution chain (first non-empty wins):
 *   1. `default` (after interpolation)
 *   2. ISO timestamp `fallbackDaysAgo` days in the past, if provided
 *   3. empty string
 */

import * as readline from 'node:readline';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';
import { interpolateString } from '../core/interpolation.js';

/** Typed config for the prompt step command. */
export interface PromptStepConfig extends StepConfig {
  readonly message: string;
  readonly options?: string[];
  readonly outputVar?: string;
  /**
   * Default value shown when prompting and used when input is empty
   * or stdin is non-interactive. Can resolve to null via interpolation
   * (e.g. memory-backed values) — treated as "no default".
   */
  readonly default?: string | null;
  /**
   * If `default` resolves to empty/null, fall back to an ISO timestamp
   * this many days in the past. Useful for first-run date prompts.
   */
  readonly fallbackDaysAgo?: number;
}

/**
 * Resolve the effective default, walking the fallback chain.
 * Exported for testing.
 */
export function resolveDefault(
  raw: string | null | undefined,
  fallbackDaysAgo: number | undefined,
  now: number = Date.now(),
): string {
  const cleaned = typeof raw === 'string' ? raw.trim() : '';
  // Treat literal stringified null/undefined (common interpolation artifacts)
  // the same as no value.
  if (cleaned && cleaned !== 'null' && cleaned !== 'undefined') {
    return cleaned;
  }
  if (typeof fallbackDaysAgo === 'number'
      && Number.isFinite(fallbackDaysAgo)
      && fallbackDaysAgo > 0) {
    return new Date(now - fallbackDaysAgo * 86_400_000).toISOString();
  }
  return '';
}

/**
 * Read one line from stdin. Resolves with the trimmed line (empty string
 * if the user just hit enter). Honors the provided abort signal.
 */
async function readLineFromStdin(
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onAbort = () => { rl.close(); reject(new Error('Prompt aborted')); };
    if (abortSignal) {
      if (abortSignal.aborted) { rl.close(); reject(new Error('Prompt aborted')); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    rl.question(prompt, (answer) => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const promptCommand: StepCommand<PromptStepConfig> = {
  type: 'prompt',
  description: 'Ask the user a question and capture the response',
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'Choices (if multiple choice)' },
      outputVar: { type: 'string', description: 'Variable name to store the response' },
      default: { type: 'string', description: 'Default value — used when input is empty or non-interactive' },
      fallbackDaysAgo: {
        type: 'number',
        description: 'Used when default resolves to empty/null — produces ISO timestamp N days ago',
      },
    },
    required: ['message'],
  } satisfies JSONSchema,

  validate(config: PromptStepConfig): ValidationResult {
    const errors = [];
    if (!config.message || typeof config.message !== 'string') {
      errors.push({ path: 'message', message: 'message is required' });
    }
    if (config.options !== undefined && !Array.isArray(config.options)) {
      errors.push({ path: 'options', message: 'options must be an array' });
    }
    if (config.default !== undefined
        && config.default !== null
        && typeof config.default !== 'string') {
      errors.push({ path: 'default', message: 'default must be a string or null' });
    }
    if (config.fallbackDaysAgo !== undefined && typeof config.fallbackDaysAgo !== 'number') {
      errors.push({ path: 'fallbackDaysAgo', message: 'fallbackDaysAgo must be a number' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: PromptStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();
    const message = interpolateString(config.message, context);

    // Interpolate default — pure-ref interpolation may yield null; tolerate it.
    let interpolatedDefault: string | null = null;
    if (typeof config.default === 'string') {
      try {
        interpolatedDefault = interpolateString(config.default, context);
      } catch {
        interpolatedDefault = null;
      }
    }

    const effectiveDefault = resolveDefault(interpolatedDefault, config.fallbackDaysAgo);

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    let response = effectiveDefault;

    if (interactive) {
      const hint = effectiveDefault ? ` [${effectiveDefault}]` : '';
      const prompt = `? ${message}${hint}: `;
      const line = await readLineFromStdin(prompt, context.abortSignal);
      response = line || effectiveDefault;
    }

    return {
      success: true,
      data: {
        message,
        options: config.options ?? null,
        outputVar: config.outputVar ?? 'response',
        response,
        default: effectiveDefault,
        interactive,
      },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'message', type: 'string' },
      { name: 'response', type: 'string', required: true },
      { name: 'outputVar', type: 'string' },
      { name: 'default', type: 'string', description: 'Effective default after fallback chain' },
      { name: 'interactive', type: 'boolean', description: 'Whether the user was actually prompted' },
    ];
  },
};
