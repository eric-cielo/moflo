/**
 * Parallel Step Command — executes nested steps concurrently (fan-out/fan-in).
 *
 * The actual parallel execution is delegated to the spell runner via
 * parallel-executor.ts. This command validates the config and returns
 * metadata about the parallel block.
 *
 * Issue #247
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';

/** Typed config for the parallel step command. */
export interface ParallelStepConfig extends StepConfig {
  /** Maximum number of steps to run simultaneously (default: unlimited). */
  readonly maxConcurrency?: number;
  /** If true (default), cancel remaining steps when one fails. */
  readonly failFast?: boolean;
}

export const parallelCommand: StepCommand<ParallelStepConfig> = {
  type: 'parallel',
  description: 'Execute nested steps concurrently with fan-out/fan-in',
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      maxConcurrency: {
        type: 'number',
        description: 'Maximum simultaneous steps (default: unlimited)',
      },
      failFast: {
        type: 'boolean',
        description: 'Cancel remaining steps on first failure (default: true)',
      },
    },
  } satisfies JSONSchema,

  validate(config: ParallelStepConfig): ValidationResult {
    const errors = [];
    if (config.maxConcurrency !== undefined) {
      if (typeof config.maxConcurrency !== 'number' || config.maxConcurrency < 1) {
        errors.push({ path: 'maxConcurrency', message: 'maxConcurrency must be a positive integer' });
      }
    }
    if (config.failFast !== undefined && typeof config.failFast !== 'boolean') {
      errors.push({ path: 'failFast', message: 'failFast must be a boolean' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: ParallelStepConfig): Promise<StepOutput> {
    const start = Date.now();
    return {
      success: true,
      data: {
        maxConcurrency: config.maxConcurrency ?? 0,
        failFast: config.failFast ?? true,
      },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'maxConcurrency', type: 'number', required: true },
      { name: 'failFast', type: 'boolean', required: true },
      { name: 'stepOutputs', type: 'object' },
    ];
  },
};
