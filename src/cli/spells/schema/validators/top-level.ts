/**
 * Top-level spell validation.
 *
 * Covers:
 * - Required top-level fields (name, steps).
 * - Argument definition shape (`arguments` block).
 * - The `matchesArgumentType` helper, shared with `resolveArguments`.
 */

import type { ValidationError } from '../../types/step-command.types.js';
import type {
  SpellDefinition,
  ArgumentDefinition,
  ArgumentType,
} from '../../types/spell-definition.types.js';

export const VALID_ARG_TYPES: readonly ArgumentType[] = ['string', 'number', 'boolean', 'string[]'];

export function validateTopLevel(def: SpellDefinition, errors: ValidationError[]): void {
  if (!def.name || typeof def.name !== 'string') {
    errors.push({ path: 'name', message: 'name is required and must be a string' });
  }
  if (!def.steps || !Array.isArray(def.steps) || def.steps.length === 0) {
    errors.push({ path: 'steps', message: 'steps is required and must be a non-empty array' });
  }
}

export function validateArguments(
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

/**
 * Validate the optional `sandbox` block on a spell definition.
 * Accepts: missing, `{}`, `{ required: boolean }`.
 * Rejects: non-object value, non-boolean `required`.
 */
export function validateSandbox(def: SpellDefinition, errors: ValidationError[]): void {
  const sandbox = (def as { sandbox?: unknown }).sandbox;
  if (sandbox === undefined) return;

  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    errors.push({ path: 'sandbox', message: 'sandbox must be an object' });
    return;
  }

  const { required } = sandbox as { required?: unknown };
  if (required !== undefined && typeof required !== 'boolean') {
    errors.push({ path: 'sandbox.required', message: 'sandbox.required must be a boolean' });
  }
}

/**
 * Validate a spell's optional `budget` block (issue #1335).
 *
 * A typo here is silent and expensive in the wrong direction: an unrecognised
 * key means "no ceiling", so a spell the author believed was capped would run
 * unbounded on the daemon. Reject the shape at parse time instead.
 */
export function validateBudget(def: SpellDefinition, errors: ValidationError[]): void {
  const budget = (def as { budget?: unknown }).budget;
  if (budget === undefined) return;

  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    errors.push({ path: 'budget', message: 'budget must be an object' });
    return;
  }

  const known = ['maxModelInvocations', 'maxWallClockMs'] as const;
  const rec = budget as Record<string, unknown>;

  for (const key of Object.keys(rec)) {
    if (!(known as readonly string[]).includes(key)) {
      errors.push({
        path: `budget.${key}`,
        message: `unknown budget key "${key}". Valid keys: ${known.join(', ')}`,
      });
    }
  }

  for (const key of known) {
    const value = rec[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push({
        path: `budget.${key}`,
        message: `budget.${key} must be a number greater than 0`,
      });
    }
  }
}

/** Check whether a value matches a declared ArgumentType. */
export function matchesArgumentType(value: unknown, type: ArgumentType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every(v => typeof v === 'string');
    default: return true;
  }
}
