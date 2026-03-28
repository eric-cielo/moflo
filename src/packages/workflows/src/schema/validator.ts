/**
 * Workflow Definition Validator
 *
 * Validates parsed workflow definitions for correctness:
 * - Required fields present
 * - Valid step types (against a known registry)
 * - No duplicate step IDs
 * - No circular variable references
 * - Valid argument definitions
 * - Undefined step output references detected
 */

import type { ValidationResult, ValidationError } from '../types/step-command.types.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  ArgumentDefinition,
  ArgumentType,
} from '../types/workflow-definition.types.js';
import { validateStepCapabilities } from '../core/capability-validator.js';

const VALID_ARG_TYPES: readonly ArgumentType[] = ['string', 'number', 'boolean', 'string[]'];

export interface ValidatorOptions {
  /** Known step command types. If provided, unknown types produce an error. */
  knownStepTypes?: readonly string[];
}

/**
 * Validate a WorkflowDefinition.
 */
export function validateWorkflowDefinition(
  def: WorkflowDefinition,
  options?: ValidatorOptions,
): ValidationResult {
  const errors: ValidationError[] = [];

  validateTopLevel(def, errors);
  if (def.arguments) {
    validateArguments(def.arguments, errors);
  }
  if (def.steps) {
    const stepIds = new Set<string>();
    const outputVars = new Set<string>();
    validateSteps(def.steps, errors, stepIds, outputVars, options);
    validateVariableReferences(def.steps, outputVars, def.arguments, errors);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Top-level validation
// ============================================================================

function validateTopLevel(def: WorkflowDefinition, errors: ValidationError[]): void {
  if (!def.name || typeof def.name !== 'string') {
    errors.push({ path: 'name', message: 'name is required and must be a string' });
  }
  if (!def.steps || !Array.isArray(def.steps) || def.steps.length === 0) {
    errors.push({ path: 'steps', message: 'steps is required and must be a non-empty array' });
  }
}

// ============================================================================
// Argument validation
// ============================================================================

function validateArguments(
  args: Record<string, ArgumentDefinition>,
  errors: ValidationError[],
): void {
  for (const [name, argDef] of Object.entries(args)) {
    const path = `arguments.${name}`;

    if (!argDef.type || !VALID_ARG_TYPES.includes(argDef.type)) {
      errors.push({
        path: `${path}.type`,
        message: `type must be one of: ${VALID_ARG_TYPES.join(', ')}`,
      });
    }

    if (argDef.default !== undefined && argDef.type) {
      if (!matchesArgumentType(argDef.default, argDef.type)) {
        errors.push({
          path: `${path}.default`,
          message: `default value ${JSON.stringify(argDef.default)} does not match declared type "${argDef.type}"`,
        });
      }
    }

    if (argDef.enum !== undefined) {
      if (!Array.isArray(argDef.enum) || argDef.enum.length === 0) {
        errors.push({ path: `${path}.enum`, message: 'enum must be a non-empty array' });
      } else if (argDef.type) {
        for (const enumVal of argDef.enum) {
          if (!matchesArgumentType(enumVal, argDef.type)) {
            errors.push({
              path: `${path}.enum`,
              message: `enum value ${JSON.stringify(enumVal)} does not match declared type "${argDef.type}"`,
            });
            break; // one error per enum is sufficient
          }
        }
      }
    }

    if (argDef.default !== undefined && argDef.enum !== undefined) {
      if (!argDef.enum.includes(argDef.default)) {
        errors.push({
          path: `${path}.default`,
          message: `default value "${argDef.default}" is not in enum: ${argDef.enum.join(', ')}`,
        });
      }
    }
  }
}

// ============================================================================
// Step validation
// ============================================================================

function validateSteps(
  steps: readonly StepDefinition[],
  errors: ValidationError[],
  stepIds: Set<string>,
  outputVars: Set<string>,
  options?: ValidatorOptions,
  prefix = 'steps',
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${prefix}[${i}]`;

    if (!step.id || typeof step.id !== 'string') {
      errors.push({ path: `${path}.id`, message: 'step id is required' });
    } else if (stepIds.has(step.id)) {
      errors.push({ path: `${path}.id`, message: `duplicate step id: "${step.id}"` });
    } else {
      stepIds.add(step.id);
    }

    if (!step.type || typeof step.type !== 'string') {
      errors.push({ path: `${path}.type`, message: 'step type is required' });
    } else if (options?.knownStepTypes && !options.knownStepTypes.includes(step.type)) {
      const suggestions = findSimilar(step.type, options.knownStepTypes);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      errors.push({
        path: `${path}.type`,
        message: `unknown step type: "${step.type}".${hint}`,
      });
    }

    if (step.output) {
      outputVars.add(step.output);
    }

    // Validate capabilities if declared
    const capErrors = validateStepCapabilities(step, path);
    errors.push(...capErrors);

    // Recurse into nested steps (condition/loop)
    if (step.steps && Array.isArray(step.steps)) {
      validateSteps(step.steps, errors, stepIds, outputVars, options, `${path}.steps`);
    }
  }
}

// ============================================================================
// Variable reference validation
// ============================================================================

/**
 * Check that {stepId.outputKey} references point to declared step outputs.
 * Also detects forward references (referencing a step that hasn't executed yet).
 */
function validateVariableReferences(
  steps: readonly StepDefinition[],
  outputVars: Set<string>,
  args?: Record<string, ArgumentDefinition>,
  errors?: ValidationError[],
  prefix = 'steps',
): void {
  if (!errors) return;
  const declaredStepIds: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${prefix}[${i}]`;

    // Check string config values for variable references
    if (step.config) {
      for (const [key, value] of Object.entries(step.config)) {
        if (typeof value === 'string') {
          checkStringReferences(value, declaredStepIds, args, errors, `${path}.config.${key}`);
        }
      }
    }

    // After checking, this step's output is now available to subsequent steps
    if (step.id) {
      declaredStepIds.push(step.id);
    }

    // Recurse into nested steps (condition/loop bodies)
    if (step.steps && Array.isArray(step.steps)) {
      validateVariableReferences(step.steps, outputVars, args, errors, `${path}.steps`);
    }
  }
}

const VAR_REF_PATTERN = /\{([^}]+)\}/g;

function checkStringReferences(
  value: string,
  declaredStepIds: string[],
  args?: Record<string, ArgumentDefinition>,
  errors?: ValidationError[],
  path?: string,
): void {
  if (!errors || !path) return;

  VAR_REF_PATTERN.lastIndex = 0;
  let match;
  while ((match = VAR_REF_PATTERN.exec(value)) !== null) {
    const ref = match[1];
    const segments = ref.split('.');

    // {args.key} — check arg is defined
    if (segments[0] === 'args' && segments.length === 2) {
      if (args && !args[segments[1]]) {
        errors.push({
          path,
          message: `references undefined argument: "${segments[1]}"`,
        });
      }
      continue;
    }

    // {credentials.NAME} — resolved at runtime by the runner
    if (segments[0] === 'credentials' && segments.length === 2) {
      continue;
    }

    // {stepId.outputKey} — check step has been declared before this point
    if (segments.length >= 2) {
      const stepId = segments[0];
      if (!declaredStepIds.includes(stepId)) {
        // Check if it's a forward reference to a later step
        errors.push({
          path,
          message: `references step "${stepId}" which has not been declared yet (forward reference)`,
        });
      }
    }
  }
}

// ============================================================================
// Argument resolution
// ============================================================================

/**
 * Resolve provided arguments against definitions, applying defaults and validation.
 */
export function resolveArguments(
  definitions: Record<string, ArgumentDefinition>,
  provided: Record<string, unknown>,
): { resolved: Record<string, unknown>; errors: ValidationError[] } {
  const resolved: Record<string, unknown> = {};
  const errors: ValidationError[] = [];

  for (const [name, def] of Object.entries(definitions)) {
    let value = provided[name];

    if (value === undefined) {
      if (def.default !== undefined) {
        value = def.default;
      } else if (def.required) {
        errors.push({
          path: `arguments.${name}`,
          message: `required argument "${name}" was not provided`,
        });
        continue;
      }
    }

    if (value !== undefined && def.type && !matchesArgumentType(value, def.type)) {
      errors.push({
        path: `arguments.${name}`,
        message: `value ${JSON.stringify(value)} does not match declared type "${def.type}"`,
      });
      continue;
    }

    if (value !== undefined && def.enum) {
      if (!def.enum.includes(value)) {
        errors.push({
          path: `arguments.${name}`,
          message: `value "${value}" is not in enum: ${def.enum.join(', ')}`,
        });
        continue;
      }
    }

    if (value !== undefined) {
      resolved[name] = value;
    }
  }

  // Flag unknown argument keys (likely typos)
  for (const key of Object.keys(provided)) {
    if (!(key in definitions)) {
      errors.push({
        path: `arguments.${key}`,
        message: `unknown argument "${key}"`,
      });
    }
  }

  return { resolved, errors };
}

// ============================================================================
// Helpers
// ============================================================================

/** Check whether a value matches a declared ArgumentType. */
function matchesArgumentType(value: unknown, type: ArgumentType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every(v => typeof v === 'string');
    default: return true;
  }
}

function findSimilar(target: string, candidates: readonly string[]): string[] {
  return candidates
    .filter(c => {
      // Simple check: shares at least 3 characters or starts with same prefix
      const common = [...target].filter(ch => c.includes(ch)).length;
      return common >= 3 || c.startsWith(target.slice(0, 3));
    })
    .slice(0, 3);
}
