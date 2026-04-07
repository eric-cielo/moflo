/**
 * Variable Interpolation
 *
 * Resolves `{stepId.outputKey}` placeholders in workflow step configs.
 * Nested property access is supported: `{step1.data.nested.value}`.
 */
import type { CastingContext } from '../types/step-command.types.js';
/** Matches `{path}` variable references in workflow step configs. */
export declare const VAR_REF_PATTERN: RegExp;
/**
 * Interpolate all `{path}` placeholders in a string.
 * @throws if a referenced variable is not found.
 */
export declare function interpolateString(template: string, context: CastingContext): string;
/**
 * Shell-escape a value by wrapping it in single quotes.
 * Internal single quotes are escaped as `'\''` (end quote, escaped quote, restart quote).
 * This prevents shell metacharacter injection (`;`, `|`, `` ` ``, `$()`, `&&`, `||`).
 */
export declare function shellEscapeValue(value: string): string;
/**
 * Interpolate `{path}` placeholders with shell-escaped values.
 * The static command template is kept intact — only interpolated variable values
 * are escaped (wrapped in single quotes with internal quotes handled).
 * Use this for strings that will be passed to a POSIX shell (`/bin/sh` or `bash`).
 * @throws if a referenced variable is not found.
 */
export declare function shellInterpolateString(template: string, context: CastingContext): string;
/**
 * Interpolate string values in a config object (deep — recursively walks nested objects and arrays).
 * Non-string primitives (numbers, booleans, null) are passed through unchanged.
 */
export declare function interpolateConfig(config: Record<string, unknown>, context: CastingContext): Record<string, unknown>;
/**
 * Recursively strip `__proto__`, `constructor`, and `prototype` keys from a
 * parsed object tree. Returns a sanitized deep copy — the original is not
 * mutated.
 */
export declare function sanitizeObjectKeys(value: unknown): unknown;
//# sourceMappingURL=interpolation.d.ts.map