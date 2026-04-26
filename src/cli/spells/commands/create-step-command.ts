/**
 * Step Command Factory
 *
 * Type-safe factory for creating StepCommand implementations.
 * Enforces the full interface at authoring time, unlike duck-typing
 * validation at registration which only checks property existence.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  StepCapability,
  MofloLevel,
  Prerequisite,
} from '../types/step-command.types.js';

export interface StepCommandDefinition<TConfig extends StepConfig = StepConfig> {
  readonly type: string;
  readonly description: string;
  readonly configSchema: JSONSchema;
  readonly capabilities?: readonly StepCapability[];
  readonly defaultMofloLevel?: MofloLevel;
  readonly prerequisites?: readonly Prerequisite[];

  validate(config: TConfig, context: CastingContext): ValidationResult | Promise<ValidationResult>;
  execute(config: TConfig, context: CastingContext): Promise<StepOutput>;
  describeOutputs(): OutputDescriptor[];
  rollback?(config: TConfig, context: CastingContext): Promise<void>;
}

/**
 * Create a StepCommand from a definition object.
 * Validates required fields at runtime and returns a frozen command.
 *
 * @throws if type or description are missing/empty
 */
export function createStepCommand<TConfig extends StepConfig = StepConfig>(
  def: StepCommandDefinition<TConfig>,
): StepCommand<TConfig> {
  if (!def.type || typeof def.type !== 'string') {
    throw new Error('StepCommand type is required and must be a non-empty string');
  }
  if (!def.description || typeof def.description !== 'string') {
    throw new Error('StepCommand description is required and must be a non-empty string');
  }
  if (!def.configSchema || typeof def.configSchema !== 'object') {
    throw new Error('StepCommand configSchema is required and must be an object');
  }
  if (typeof def.validate !== 'function') {
    throw new Error('StepCommand validate must be a function');
  }
  if (typeof def.execute !== 'function') {
    throw new Error('StepCommand execute must be a function');
  }
  if (typeof def.describeOutputs !== 'function') {
    throw new Error('StepCommand describeOutputs must be a function');
  }

  return Object.freeze({ ...def });
}
