/**
 * Capability Validator
 *
 * Story #108: Tier 1 capability declaration and enforcement.
 * Each step command declares required capabilities. Workflow YAML can further
 * restrict (never expand) capabilities per step. The runner checks capabilities
 * before execution and blocks undeclared access.
 */
import type { StepCapability, CapabilityType, StepCommand, MofloLevel } from '../types/step-command.types.js';
import type { StepDefinition } from '../types/workflow-definition.types.js';
export interface CapabilityViolation {
    readonly capability: CapabilityType;
    readonly reason: string;
    readonly stepId: string;
    readonly stepType: string;
}
export interface CapabilityCheckResult {
    readonly allowed: boolean;
    readonly violations: readonly CapabilityViolation[];
    readonly effectiveCaps: readonly StepCapability[];
}
export declare const VALID_CAPABILITY_TYPES: ReadonlySet<string>;
/**
 * Check whether a step is allowed to execute given its command's declared
 * capabilities and any per-step restrictions from the workflow YAML.
 *
 * Restrictions in YAML can only **narrow** the command's defaults — they
 * cannot grant new capability types the command doesn't declare.
 */
export declare function checkCapabilities(step: StepDefinition, command: StepCommand): CapabilityCheckResult;
/**
 * Validate that a capability type string is a known type.
 */
export declare function isValidCapabilityType(type: string): type is CapabilityType;
/**
 * Validate step capabilities in a workflow definition (for schema validation).
 */
export declare function validateStepCapabilities(step: StepDefinition, path: string): Array<{
    path: string;
    message: string;
}>;
/**
 * Enforce scope restrictions at runtime.
 *
 * Call this from command.execute() to verify that a requested resource
 * falls within the effective scope. Returns null if allowed, or a
 * violation object if the resource is outside the permitted scope.
 *
 * If no scope is defined for the capability type, access is unrestricted.
 */
export declare function enforceScope(effectiveCaps: readonly StepCapability[], capabilityType: CapabilityType, resource: string, stepId: string, stepType: string): CapabilityViolation | null;
/**
 * Format capability violations into a human-readable error message.
 */
export declare function formatViolations(violations: readonly CapabilityViolation[]): string;
/**
 * Check if a string is a valid MofloLevel.
 */
export declare function isValidMofloLevel(level: string): level is MofloLevel;
/**
 * Compare two MoFlo levels. Returns:
 *  - negative if a < b (a is less permissive)
 *  - 0 if equal
 *  - positive if a > b (a is more permissive)
 */
export declare function compareMofloLevels(a: MofloLevel, b: MofloLevel): number;
/**
 * Get the default MoFlo integration level for a step type.
 * The command's `defaultMofloLevel` is the authoritative source;
 * falls back to 'none' when no command is available.
 */
export declare function getDefaultMofloLevel(_stepType: string, command?: StepCommand): MofloLevel;
/**
 * Resolve the effective MoFlo level for a step given workflow defaults,
 * step overrides, command defaults, and parent constraints.
 *
 * Resolution order (most specific wins, but can only narrow):
 * 1. Command declares its default level
 * 2. Workflow definition may set a workflow-wide level
 * 3. Step may override with its own level (must not exceed workflow level)
 * 4. Parent workflow constrains the maximum level (for recursive invocation)
 */
export declare function resolveMofloLevel(step: StepDefinition, command: StepCommand | undefined, workflowLevel: MofloLevel | undefined, parentLevel: MofloLevel | undefined): MofloLevel;
//# sourceMappingURL=capability-validator.d.ts.map