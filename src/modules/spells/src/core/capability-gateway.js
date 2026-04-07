/**
 * Capability Gateway
 *
 * Issue #258: Shared enforcement layer that all step commands must use for I/O.
 * Replaces inline enforceScope() calls with a structural gateway that cannot be
 * bypassed — commands receive the gateway via CastingContext and call typed
 * check methods before performing any gated operation.
 */
import { enforceScope, formatViolations } from './capability-validator.js';
// ── Error ────────────────────────────────────────────────────────────────
export class CapabilityDeniedError extends Error {
    violation;
    constructor(violation) {
        super(formatViolations([violation]));
        this.name = 'CapabilityDeniedError';
        this.violation = violation;
    }
}
// ── Implementation ───────────────────────────────────────────────────────
/**
 * Concrete gateway bound to a step's effective capabilities.
 * Each check method throws CapabilityDeniedError if the operation is denied.
 */
export class CapabilityGateway {
    caps;
    stepId;
    stepType;
    constructor(caps, stepId, stepType) {
        this.caps = caps;
        this.stepId = stepId;
        this.stepType = stepType;
    }
    checkNet(url) {
        this.enforce('net', url);
    }
    checkShell(command) {
        this.enforce('shell', command);
    }
    checkFsRead(path) {
        this.enforce('fs:read', path);
    }
    checkFsWrite(path) {
        this.enforce('fs:write', path);
    }
    checkAgent(agentType) {
        this.enforce('agent', agentType);
    }
    checkMemory(namespace) {
        this.enforce('memory', namespace);
    }
    checkBrowser() {
        this.enforce('browser', '');
    }
    checkBrowserEvaluate() {
        this.enforce('browser:evaluate', '');
    }
    checkCredentials(name) {
        this.enforce('credentials', name);
    }
    enforce(capabilityType, resource) {
        const violation = enforceScope(this.caps, capabilityType, resource, this.stepId, this.stepType);
        if (violation) {
            throw new CapabilityDeniedError(violation);
        }
    }
}
/**
 * Deny-all gateway used as the default on CastingContext (#266).
 * Any code path that reaches a gateway check without going through
 * step-executor (which installs a properly-scoped gateway) will hit
 * this and fail loud rather than silently skipping enforcement.
 */
export class DenyAllGateway {
    deny(capabilityType, resource) {
        throw new CapabilityDeniedError({
            capability: capabilityType,
            stepId: 'unknown',
            stepType: 'unknown',
            reason: `Capability "${capabilityType}" denied for "${resource}" — no scoped gateway configured for this code path`,
        });
    }
    checkNet(url) { this.deny('net', url); }
    checkShell(command) { this.deny('shell', command); }
    checkFsRead(path) { this.deny('fs:read', path); }
    checkFsWrite(path) { this.deny('fs:write', path); }
    checkAgent(agentType) { this.deny('agent', agentType); }
    checkMemory(namespace) { this.deny('memory', namespace); }
    checkBrowser() { this.deny('browser', ''); }
    checkBrowserEvaluate() { this.deny('browser:evaluate', ''); }
    checkCredentials(name) { this.deny('credentials', name); }
}
/** Shared singleton — immutable, safe to reuse across contexts. */
export const DENY_ALL_GATEWAY = new DenyAllGateway();
// Re-export disclosure functions from their dedicated module (#267)
export { discloseStep, discloseWorkflow, formatStepDisclosure, formatWorkflowDisclosure, } from './capability-disclosure.js';
//# sourceMappingURL=capability-gateway.js.map