/**
 * Capability Gateway
 *
 * Issue #258: Shared enforcement layer that all step commands must use for I/O.
 * Replaces inline enforceScope() calls with a structural gateway that cannot be
 * bypassed — commands receive the gateway via CastingContext and call typed
 * check methods before performing any gated operation.
 */

import type {
  StepCapability,
  CapabilityType,
} from '../types/step-command.types.js';
import { enforceScope, formatViolations, type CapabilityViolation } from './capability-validator.js';

// ── Error ────────────────────────────────────────────────────────────────

export class CapabilityDeniedError extends Error {
  readonly violation: CapabilityViolation;

  constructor(violation: CapabilityViolation) {
    super(formatViolations([violation]));
    this.name = 'CapabilityDeniedError';
    this.violation = violation;
  }
}

// ── Gateway Interface ────────────────────────────────────────────────────

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

// ── Implementation ───────────────────────────────────────────────────────

/**
 * Concrete gateway bound to a step's effective capabilities.
 * Each check method throws CapabilityDeniedError if the operation is denied.
 */
export class CapabilityGateway implements ICapabilityGateway {
  private readonly caps: readonly StepCapability[];
  private readonly stepId: string;
  private readonly stepType: string;

  constructor(caps: readonly StepCapability[], stepId: string, stepType: string) {
    this.caps = caps;
    this.stepId = stepId;
    this.stepType = stepType;
  }

  checkNet(url: string): void {
    this.enforce('net', url);
  }

  checkShell(command: string): void {
    this.enforce('shell', command);
  }

  checkFsRead(path: string): void {
    this.enforce('fs:read', path);
  }

  checkFsWrite(path: string): void {
    this.enforce('fs:write', path);
  }

  checkAgent(agentType: string): void {
    this.enforce('agent', agentType);
  }

  checkMemory(namespace: string): void {
    this.enforce('memory', namespace);
  }

  checkBrowser(): void {
    this.enforce('browser', '');
  }

  checkBrowserEvaluate(): void {
    this.enforce('browser:evaluate', '');
  }

  checkCredentials(name: string): void {
    this.enforce('credentials', name);
  }

  private enforce(capabilityType: CapabilityType, resource: string): void {
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
export class DenyAllGateway implements ICapabilityGateway {
  private deny(capabilityType: CapabilityType, resource: string): never {
    throw new CapabilityDeniedError({
      capability: capabilityType,
      stepId: 'unknown',
      stepType: 'unknown',
      reason: `Capability "${capabilityType}" denied for "${resource}" — no scoped gateway configured for this code path`,
    });
  }

  checkNet(url: string): void { this.deny('net', url); }
  checkShell(command: string): void { this.deny('shell', command); }
  checkFsRead(path: string): void { this.deny('fs:read', path); }
  checkFsWrite(path: string): void { this.deny('fs:write', path); }
  checkAgent(agentType: string): void { this.deny('agent', agentType); }
  checkMemory(namespace: string): void { this.deny('memory', namespace); }
  checkBrowser(): void { this.deny('browser', ''); }
  checkBrowserEvaluate(): void { this.deny('browser:evaluate', ''); }
  checkCredentials(name: string): void { this.deny('credentials', name); }
}

/** Shared singleton — immutable, safe to reuse across contexts. */
export const DENY_ALL_GATEWAY: ICapabilityGateway = new DenyAllGateway();

// Re-export disclosure functions from their dedicated module (#267)
export {
  discloseStep,
  discloseWorkflow,
  formatStepDisclosure,
  formatWorkflowDisclosure,
  type StepDisclosureSummary,
  type WorkflowDisclosureSummary,
} from './capability-disclosure.js';
