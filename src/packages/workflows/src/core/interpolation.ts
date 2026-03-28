/**
 * Variable Interpolation
 *
 * Resolves `{stepId.outputKey}` placeholders in workflow step configs.
 * Nested property access is supported: `{step1.data.nested.value}`.
 */

import type { WorkflowContext } from '../types/step-command.types.js';

const INTERPOLATION_PATTERN = /\{([^}]+)\}/g;

/**
 * Resolve a dot-separated path against the context variables.
 * Returns undefined if any segment is missing.
 */
/**
 * Resolution precedence:
 * 1. {args.key} — explicit args prefix (depth-2 only)
 * 2. {stepId.outputKey} — walk context.variables
 * 3. {key} — single-segment fallback to context.args
 */
function resolveVariable(path: string, context: WorkflowContext): unknown {
  const segments = path.split('.');

  // Explicit args. prefix: {args.key}
  if (segments[0] === 'args' && segments.length === 2) {
    const val = context.args[segments[1]];
    if (val !== undefined) return val;
  }

  // Walk context.variables (step outputs): {stepId.outputKey}
  let value: unknown = context.variables;
  for (const segment of segments) {
    if (value === null || value === undefined || typeof value !== 'object') {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (value !== undefined) return value;

  // Fallback: single-segment matches args directly: {issueNumber}
  if (segments.length === 1) {
    return context.args[segments[0]];
  }

  return undefined;
}

/**
 * Interpolate all `{path}` placeholders in a string.
 * @throws if a referenced variable is not found.
 */
export function interpolateString(template: string, context: WorkflowContext): string {
  return template.replace(INTERPOLATION_PATTERN, (match, path: string) => {
    const value = resolveVariable(path, context);
    if (value === undefined) {
      throw new Error(`Variable not found: ${path}`);
    }
    return String(value);
  });
}

/**
 * Interpolate string values in a config object (shallow — top-level keys only).
 * Non-string values and nested objects are passed through unchanged.
 */
export function interpolateConfig(
  config: Record<string, unknown>,
  context: WorkflowContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      result[key] = interpolateString(value, context);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' ? interpolateString(item, context) : item
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
