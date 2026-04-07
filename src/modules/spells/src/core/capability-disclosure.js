/**
 * Capability Disclosure
 *
 * Issue #267: Extracted from capability-gateway.ts to separate disclosure
 * (transparency) from enforcement (security). Disclosure functions generate
 * human-readable summaries of what capabilities each step/workflow has.
 */
import { VALID_CAPABILITY_TYPES } from './capability-validator.js';
/** All known capability types, derived from the canonical set in capability-validator. */
const ALL_CAPABILITY_TYPES = [...VALID_CAPABILITY_TYPES];
/** Human-readable descriptions for capability types. */
const CAPABILITY_LABELS = {
    'fs:read': 'Read files',
    'fs:write': 'Write files',
    'net': 'Access the network',
    'shell': 'Execute shell commands',
    'memory': 'Access memory namespaces',
    'credentials': 'Access credentials',
    'browser': 'Launch browser sessions',
    'browser:evaluate': 'Execute JavaScript in browser',
    'agent': 'Spawn sub-agents',
};
/**
 * Generate a disclosure summary for a single step's capabilities.
 */
export function discloseStep(stepName, caps) {
    const grantedTypes = new Set(caps.map(c => c.type));
    const granted = caps.map(c => ({
        name: c.type,
        type: c.type,
        label: CAPABILITY_LABELS[c.type],
        scope: c.scope,
    }));
    const denied = ALL_CAPABILITY_TYPES.filter(t => !grantedTypes.has(t));
    return { stepName, granted, denied };
}
/**
 * Generate an aggregate disclosure summary across all steps in a workflow.
 */
export function discloseWorkflow(workflowName, steps) {
    const aggregate = new Map();
    const usedTypes = new Set();
    for (const step of steps) {
        for (const cap of step.caps) {
            usedTypes.add(cap.type);
            const existing = aggregate.get(cap.type) ?? [];
            existing.push(step.name);
            aggregate.set(cap.type, existing);
        }
    }
    const unused = ALL_CAPABILITY_TYPES.filter(t => !usedTypes.has(t));
    return { workflowName, stepCount: steps.length, aggregate, unused };
}
/**
 * Format a step disclosure summary as a human-readable string.
 */
export function formatStepDisclosure(summary) {
    const lines = [];
    lines.push(`  Capabilities:`);
    for (const cap of summary.granted) {
        const scopeNote = cap.scope?.length
            ? ` (scoped to: ${cap.scope.join(', ')})`
            : '';
        lines.push(`    \u2726 ${cap.type.padEnd(18)} \u2014 ${cap.label}${scopeNote}`);
    }
    if (summary.denied.length > 0) {
        const deniedLabels = summary.denied.map(t => CAPABILITY_LABELS[t].toLowerCase());
        lines.push('');
        lines.push(`  This step cannot: ${deniedLabels.join(', ')}`);
    }
    return lines.join('\n');
}
/**
 * Format a workflow disclosure summary as a human-readable string.
 */
export function formatWorkflowDisclosure(summary) {
    const lines = [];
    lines.push(`  Aggregate capabilities:`);
    for (const [capType, stepNames] of summary.aggregate) {
        lines.push(`    \u2726 ${capType.padEnd(18)} \u2014 Steps: ${stepNames.join(', ')}`);
    }
    if (summary.unused.length > 0) {
        lines.push('');
        lines.push(`  No steps use: ${summary.unused.join(', ')}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=capability-disclosure.js.map