/**
 * Spell Definition Validator
 *
 * Validates parsed spell definitions for correctness:
 * - Required fields present
 * - Valid step types (against a known registry)
 * - No duplicate step IDs
 * - No circular variable references
 * - Valid argument definitions
 * - Undefined step output references detected
 *
 * This module is a thin composition entry; the actual rules live under
 * `./validators/` and each file owns a single concern (top-level,
 * steps, prerequisites, references, jumps).
 */

import type { ValidationResult, ValidationError } from '../types/step-command.types.js';
import type {
  SpellDefinition,
  ArgumentDefinition,
} from '../types/spell-definition.types.js';
import { isValidMofloLevel } from '../core/capability-validator.js';
import { MOFLO_LEVEL_ORDER } from '../types/step-command.types.js';
import { validateSchedule } from '../scheduler/cron-parser.js';
import { validateTopLevel, validateArguments, matchesArgumentType } from './validators/top-level.js';
import { validateSteps } from './validators/steps.js';
import { validatePrerequisites } from './validators/prerequisites.js';
import { validateVariableReferences } from './validators/references.js';
import { detectCircularJumps } from './validators/jumps.js';

export interface ValidatorOptions {
  /** Known step command types. If provided, unknown types produce an error. */
  knownStepTypes?: readonly string[];
}

/**
 * Validate a SpellDefinition.
 */
export function validateSpellDefinition(
  def: SpellDefinition,
  options?: ValidatorOptions,
): ValidationResult {
  const errors: ValidationError[] = [];

  validateTopLevel(def, errors);

  if (def.mofloLevel !== undefined && !isValidMofloLevel(def.mofloLevel)) {
    errors.push({
      path: 'mofloLevel',
      message: `invalid mofloLevel: "${def.mofloLevel}". Valid levels: ${MOFLO_LEVEL_ORDER.join(', ')}`,
    });
  }

  if (def.schedule) {
    errors.push(...validateSchedule(def.schedule, 'schedule'));
  }
  if (def.arguments) {
    validateArguments(def.arguments, errors);
  }
  if (def.prerequisites !== undefined) {
    validatePrerequisites(def.prerequisites, errors, 'prerequisites');
  }
  if (def.steps) {
    const stepIds = new Set<string>();
    const outputVars = new Set<string>();
    validateSteps(def.steps, errors, stepIds, outputVars, options, 'steps', def.mofloLevel);
    validateVariableReferences(def.steps, outputVars, def.arguments, errors);
    detectCircularJumps(def.steps, errors);
  }

  return { valid: errors.length === 0, errors };
}

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
