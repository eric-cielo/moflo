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
import type { SpellDefinition, ArgumentDefinition } from '../types/workflow-definition.types.js';
export interface ValidatorOptions {
    /** Known step command types. If provided, unknown types produce an error. */
    knownStepTypes?: readonly string[];
}
/**
 * Validate a SpellDefinition.
 */
export declare function validateSpellDefinition(def: SpellDefinition, options?: ValidatorOptions): ValidationResult;
/**
 * Resolve provided arguments against definitions, applying defaults and validation.
 */
export declare function resolveArguments(definitions: Record<string, ArgumentDefinition>, provided: Record<string, unknown>): {
    resolved: Record<string, unknown>;
    errors: ValidationError[];
};
//# sourceMappingURL=validator.d.ts.map