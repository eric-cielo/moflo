/**
 * Capability Gateway
 *
 * Issue #258: Shared enforcement layer that all step commands must use for I/O.
 * Replaces inline enforceScope() calls with a structural gateway that cannot be
 * bypassed — commands receive the gateway via CastingContext and call typed
 * check methods before performing any gated operation.
 */
import type { StepCapability } from '../types/step-command.types.js';
import { type CapabilityViolation } from './capability-validator.js';
export declare class CapabilityDeniedError extends Error {
    readonly violation: CapabilityViolation;
    constructor(violation: CapabilityViolation);
}
export interface ICapabilityGateway {
    /** Check net access before HTTP/WebSocket calls. */
    checkNet(url: string): void;
    /** Check shell access before command execution. */
    checkShell(command: string): void;
    /** Check fs access before file read. */
    checkFsRead(path: string): void;
    /** Check fs access before file write. */
    checkFsWrite(path: string): void;
    /** Check agent spawning constraints. */
    checkAgent(agentType: string): void;
    /** Check memory access before namespace operations. */
    checkMemory(namespace: string): void;
    /** Check browser capability. */
    checkBrowser(): void;
    /** Check browser:evaluate capability. */
    checkBrowserEvaluate(): void;
    /** Check credential access at runtime (#268). */
    checkCredentials(name: string): void;
}
/**
 * Concrete gateway bound to a step's effective capabilities.
 * Each check method throws CapabilityDeniedError if the operation is denied.
 */
export declare class CapabilityGateway implements ICapabilityGateway {
    private readonly caps;
    private readonly stepId;
    private readonly stepType;
    constructor(caps: readonly StepCapability[], stepId: string, stepType: string);
    checkNet(url: string): void;
    checkShell(command: string): void;
    checkFsRead(path: string): void;
    checkFsWrite(path: string): void;
    checkAgent(agentType: string): void;
    checkMemory(namespace: string): void;
    checkBrowser(): void;
    checkBrowserEvaluate(): void;
    checkCredentials(name: string): void;
    private enforce;
}
/**
 * Deny-all gateway used as the default on CastingContext (#266).
 * Any code path that reaches a gateway check without going through
 * step-executor (which installs a properly-scoped gateway) will hit
 * this and fail loud rather than silently skipping enforcement.
 */
export declare class DenyAllGateway implements ICapabilityGateway {
    private deny;
    checkNet(url: string): void;
    checkShell(command: string): void;
    checkFsRead(path: string): void;
    checkFsWrite(path: string): void;
    checkAgent(agentType: string): void;
    checkMemory(namespace: string): void;
    checkBrowser(): void;
    checkBrowserEvaluate(): void;
    checkCredentials(name: string): void;
}
/** Shared singleton — immutable, safe to reuse across contexts. */
export declare const DENY_ALL_GATEWAY: ICapabilityGateway;
export { discloseStep, discloseWorkflow, formatStepDisclosure, formatWorkflowDisclosure, type StepDisclosureSummary, type WorkflowDisclosureSummary, } from './capability-disclosure.js';
//# sourceMappingURL=capability-gateway.d.ts.map