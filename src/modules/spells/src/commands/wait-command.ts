/**
 * Wait Step Command — pauses for a duration or until a condition is met.
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

/** Typed config for the wait step command. */
export interface WaitStepConfig extends StepConfig {
  readonly duration: number;
}

export const waitCommand: StepCommand<WaitStepConfig> = {
  type: 'wait',
  description: 'Pause workflow for a duration',
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      duration: { type: 'number', description: 'Wait duration in milliseconds' },
    },
    required: ['duration'],
  } satisfies JSONSchema,

  validate(config: WaitStepConfig): ValidationResult {
    const errors = [];
    if (config.duration === undefined || typeof config.duration !== 'number' || config.duration < 0) {
      errors.push({ path: 'duration', message: 'duration must be a non-negative number (milliseconds)' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: WaitStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();
    const duration = config.duration;

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Wait aborted'));
      };
      const timer = setTimeout(() => {
        context.abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, duration);
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });

    return {
      success: true,
      data: { waited: duration },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'waited', type: 'number', description: 'Actual wait time in ms' },
    ];
  },
};
