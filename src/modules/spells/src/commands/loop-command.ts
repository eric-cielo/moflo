/**
 * Loop Step Command — iterates over an array, executing sub-steps for each item.
 *
 * The actual sub-step execution is delegated to the workflow runner.
 * This command evaluates the iteration config and provides the loop metadata.
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

/** Typed config for the loop step command. */
export interface LoopStepConfig extends StepConfig {
  readonly over: unknown[];
  readonly steps?: string[];
  readonly maxIterations?: number;
  readonly itemVar?: string;
  readonly indexVar?: string;
}

export const loopCommand: StepCommand<LoopStepConfig> = {
  type: 'loop',
  description: 'Iterate over an array, running sub-steps for each item',
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      over: { type: 'array', description: 'Array to iterate over (or variable reference)' },
      steps: { type: 'array', description: 'Step IDs to execute per iteration' },
      maxIterations: { type: 'number', description: 'Safety limit on iterations', default: 100 },
      itemVar: { type: 'string', description: 'Variable name for current item', default: 'item' },
      indexVar: { type: 'string', description: 'Variable name for current index', default: 'index' },
    },
    required: ['over'],
  } satisfies JSONSchema,

  validate(config: LoopStepConfig): ValidationResult {
    const errors = [];
    if (config.over === undefined) {
      errors.push({ path: 'over', message: 'over is required (array to iterate)' });
    } else if (!Array.isArray(config.over)) {
      errors.push({ path: 'over', message: 'over must be an array' });
    }
    if (config.maxIterations !== undefined && (typeof config.maxIterations !== 'number' || config.maxIterations <= 0)) {
      errors.push({ path: 'maxIterations', message: 'maxIterations must be a positive number' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: LoopStepConfig): Promise<StepOutput> {
    const start = Date.now();
    const items = config.over;
    const maxIterations = config.maxIterations ?? 100;
    const actualCount = Math.min(items.length, maxIterations);
    const truncated = items.length > maxIterations;

    // Loop execution is delegated to the workflow runner.
    // This command prepares the iteration metadata.
    return {
      success: true,
      data: {
        totalItems: items.length,
        iterations: actualCount,
        truncated,
        itemVar: config.itemVar ?? 'item',
        indexVar: config.indexVar ?? 'index',
        items: items.slice(0, actualCount),
      },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'totalItems', type: 'number', required: true },
      { name: 'iterations', type: 'number', required: true },
      { name: 'truncated', type: 'boolean', required: true },
      { name: 'items', type: 'array' },
    ];
  },
};
