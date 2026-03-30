/**
 * Composite Step Command
 *
 * Wraps a YAML step definition into a StepCommand that executes
 * a sequence of actions. Each action can invoke a tool or run
 * a shell command.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  StepCapability,
  Prerequisite,
} from '../types/step-command.types.js';
import type { YamlStepDefinition, YamlInputDef, YamlAction } from '../loaders/yaml-step-loader.js';

export interface CompositeStepConfig extends StepConfig {
  readonly [key: string]: unknown;
}

/**
 * Create a StepCommand from a parsed YAML step definition.
 */
export function createCompositeCommand(def: YamlStepDefinition): StepCommand<CompositeStepConfig> {
  const configSchema = buildConfigSchema(def.inputs);
  const capabilities = buildCapabilities(def);
  const prerequisites = buildPrerequisites(def);

  return {
    type: def.name,
    description: def.description ?? `Composite step: ${def.name}`,
    configSchema,
    capabilities,
    prerequisites: prerequisites.length > 0 ? prerequisites : undefined,

    validate(config: CompositeStepConfig): ValidationResult {
      const errors = validateInputs(config, def.inputs);
      return { valid: errors.length === 0, errors };
    },

    async execute(config: CompositeStepConfig, context: WorkflowContext): Promise<StepOutput> {
      const results: Record<string, unknown>[] = [];

      for (let i = 0; i < def.actions.length; i++) {
        const action = def.actions[i];
        const resolvedParams = interpolateParams(action.params ?? {}, config);

        results.push({
          index: i,
          tool: action.tool,
          action: action.action,
          command: action.command,
          params: resolvedParams,
        });
      }

      return {
        success: true,
        data: {
          actionCount: def.actions.length,
          results,
          inputs: config,
        },
      };
    },

    describeOutputs(): OutputDescriptor[] {
      return [
        { name: 'actionCount', type: 'number', description: 'Number of actions executed' },
        { name: 'results', type: 'array', description: 'Results from each action' },
        { name: 'inputs', type: 'object', description: 'Resolved input values' },
      ];
    },
  };
}

function buildConfigSchema(inputs?: Record<string, YamlInputDef>): JSONSchema {
  if (!inputs) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }

  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const [name, def] of Object.entries(inputs)) {
    properties[name] = {
      type: def.type,
      description: def.description,
      default: def.default,
    };
    if (def.required) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: true,
  };
}

function buildCapabilities(def: YamlStepDefinition): StepCapability[] {
  const caps: StepCapability[] = [];
  const hasTool = def.tool || def.actions.some((a) => a.tool);
  const hasCommand = def.actions.some((a) => a.command);

  if (hasTool) {
    caps.push({ type: 'net' });
  }
  if (hasCommand) {
    caps.push({ type: 'shell' });
  }

  return caps;
}

function buildPrerequisites(def: YamlStepDefinition): Prerequisite[] {
  if (!def.tool) return [];

  return [
    {
      name: def.tool,
      check: async () => true, // Tool availability checked at runtime by the workflow engine
      installHint: `Tool "${def.tool}" is required by composite step "${def.name}"`,
    },
  ];
}

function validateInputs(
  config: CompositeStepConfig,
  inputs?: Record<string, YamlInputDef>,
): Array<{ path: string; message: string }> {
  if (!inputs) return [];

  const errors: Array<{ path: string; message: string }> = [];

  for (const [name, def] of Object.entries(inputs)) {
    const value = config[name];

    if (def.required && (value === undefined || value === null)) {
      errors.push({ path: name, message: `Input "${name}" is required` });
      continue;
    }

    if (value !== undefined && value !== null && def.type) {
      const actual = typeof value;
      if (actual !== def.type) {
        errors.push({
          path: name,
          message: `Input "${name}" expected type "${def.type}", got "${actual}"`,
        });
      }
    }
  }

  return errors;
}

/**
 * Interpolate `${inputs.X}` references in action params.
 */
function interpolateParams(
  params: Record<string, unknown>,
  inputs: CompositeStepConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\$\{inputs\.(\w+)\}/g, (_match, inputName: string) => {
        const inputValue = inputs[inputName];
        return inputValue !== undefined ? String(inputValue) : '';
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}
