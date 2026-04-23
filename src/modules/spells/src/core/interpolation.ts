/**
 * Variable Interpolation
 *
 * Resolves `{stepId.outputKey}` placeholders in spell step configs.
 * Nested property access is supported: `{step1.data.nested.value}`.
 */

import type { CastingContext } from '../types/step-command.types.js';

/**
 * Matches `{path}` variable references in spell step configs.
 *
 * Content must be identifier-shape: letter/underscore followed by
 * letters, digits, `_`, `.`, or `-`. This tight grammar accommodates
 * every real spell ref (`{args.x}`, `{loop.x}`, `{step-id.out}`) while
 * letting bash steps embed literal `{...}` blocks — JS destructuring
 * `{ foo }` (whitespace), object literals `{ a: b }` (colon), shell
 * expansions `${VAR}` (lookbehind), and so on — without tripping the
 * interpolator. A greedy `[^}]+` class ate JS code inside `node -e`
 * scripts and threw "Variable not found" at runtime.
 *
 * The `(?<!\$)` negative lookbehind also skips `${VAR}` — bash parameter
 * expansion inside shell steps must pass through untouched.
 */
export const VAR_REF_PATTERN = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

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
function resolveVariable(path: string, context: CastingContext): unknown {
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
export function interpolateString(template: string, context: CastingContext): string {
  return template.replace(VAR_REF_PATTERN, (match, path: string) => {
    const value = resolveVariable(path, context);
    if (value === undefined) {
      throw new Error(`Variable not found: ${path}`);
    }
    return String(value);
  });
}

/**
 * Shell-escape a value by wrapping it in single quotes.
 * Internal single quotes are escaped as `'\''` (end quote, escaped quote, restart quote).
 * This prevents shell metacharacter injection (`;`, `|`, `` ` ``, `$()`, `&&`, `||`).
 */
export function shellEscapeValue(value: string): string {
  // Always use POSIX single-quote escaping — this function is specifically
  // for shell interpolation in bash commands (bashCommand hardcodes shell: 'bash')
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Interpolate `{path}` placeholders with shell-escaped values.
 * The static command template is kept intact — only interpolated variable values
 * are escaped (wrapped in single quotes with internal quotes handled).
 * Use this for strings that will be passed to a POSIX shell (`/bin/sh` or `bash`).
 * @throws if a referenced variable is not found.
 */
export function shellInterpolateString(template: string, context: CastingContext): string {
  return template.replace(VAR_REF_PATTERN, (match, path: string) => {
    const value = resolveVariable(path, context);
    if (value === undefined) {
      throw new Error(`Variable not found: ${path}`);
    }
    return shellEscapeValue(String(value));
  });
}

/**
 * Recursively interpolate string values in a value tree.
 * Handles strings, arrays, and plain objects at any depth.
 */
function interpolateValue(value: unknown, context: CastingContext): unknown {
  if (typeof value === 'string') {
    // If the entire string is a single variable reference (e.g. "{args.stories}"),
    // return the resolved value directly to preserve its original type (array, object, etc.).
    const pureRefMatch = /^\{([^}]+)\}$/.exec(value);
    if (pureRefMatch) {
      const resolved = resolveVariable(pureRefMatch[1], context);
      if (resolved !== undefined) return resolved;
    }
    return interpolateString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolateValue(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateValue(v, context);
    }
    return result;
  }
  return value;
}

/**
 * Interpolate string values in a config object (deep — recursively walks nested objects and arrays).
 * Non-string primitives (numbers, booleans, null) are passed through unchanged.
 */
export function interpolateConfig(
  config: Record<string, unknown>,
  context: CastingContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = interpolateValue(value, context);
  }
  return result;
}

// ============================================================================
// Object sanitization (prototype pollution prevention)
// ============================================================================

/** Keys that must never appear in parsed spell objects. */
const POISONED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively strip `__proto__`, `constructor`, and `prototype` keys from a
 * parsed object tree. Returns a sanitized deep copy — the original is not
 * mutated.
 */
export function sanitizeObjectKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeObjectKeys);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (POISONED_KEYS.has(k)) continue;
    result[k] = sanitizeObjectKeys(v);
  }
  return result;
}
