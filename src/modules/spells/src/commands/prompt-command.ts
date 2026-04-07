/**
 * Prompt Step Command — asks the user a question.
 *
 * In non-interactive mode (no stdin), returns a placeholder.
 * The workflow runner can override this with a real prompt implementation.
 */

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
  readonly default?: string;
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
      default: { type: 'string', description: 'Default value if no input' },
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
    return { valid: errors.length === 0, errors };
  },

  async execute(config: PromptStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();
    const message = interpolateString(config.message, context);
    const defaultValue = config.default
      ? interpolateString(config.default, context)
      : undefined;

    // Prompt execution is delegated to the workflow runner's I/O handler.
    // This command prepares the prompt config; actual user interaction is external.
    return {
      success: true,
      data: {
        message,
        options: config.options ?? null,
        outputVar: config.outputVar ?? 'response',
        response: defaultValue ?? '',
      },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'message', type: 'string' },
      { name: 'response', type: 'string', required: true },
      { name: 'outputVar', type: 'string' },
    ];
  },
};
