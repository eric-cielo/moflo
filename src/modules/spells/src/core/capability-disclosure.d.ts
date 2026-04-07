/**
 * Capability Disclosure
 *
 * Issue #267: Extracted from capability-gateway.ts to separate disclosure
 * (transparency) from enforcement (security). Disclosure functions generate
 * human-readable summaries of what capabilities each step/workflow has.
 */
import type { StepCapability, CapabilityType } from '../types/step-command.types.js';
interface CapabilityDisclosure {
    readonly name: string;
    readonly type: CapabilityType;
    readonly label: string;
    readonly scope?: readonly string[];
}
export interface StepDisclosureSummary {
    readonly stepName: string;
    readonly granted: readonly CapabilityDisclosure[];
    readonly denied: readonly CapabilityType[];
}
export interface WorkflowDisclosureSummary {
    readonly workflowName: string;
    readonly stepCount: number;
    /** Capability type -> list of step names that use it. */
    readonly aggregate: ReadonlyMap<CapabilityType, readonly string[]>;
    /** Capability types not used by any step. */
    readonly unused: readonly CapabilityType[];
}
/**
 * Generate a disclosure summary for a single step's capabilities.
 */
export declare function discloseStep(stepName: string, caps: readonly StepCapability[]): StepDisclosureSummary;
/**
 * Generate an aggregate disclosure summary across all steps in a workflow.
 */
export declare function discloseWorkflow(workflowName: string, steps: ReadonlyArray<{
    name: string;
    caps: readonly StepCapability[];
}>): WorkflowDisclosureSummary;
/**
 * Format a step disclosure summary as a human-readable string.
 */
export declare function formatStepDisclosure(summary: StepDisclosureSummary): string;
/**
 * Format a workflow disclosure summary as a human-readable string.
 */
export declare function formatWorkflowDisclosure(summary: WorkflowDisclosureSummary): string;
export {};
//# sourceMappingURL=capability-disclosure.d.ts.map