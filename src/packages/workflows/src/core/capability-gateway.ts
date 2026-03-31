/**
 * Capability Gateway
 *
 * Issue #258: Shared enforcement layer that all step commands must use for I/O.
 * Replaces inline enforceScope() calls with a structural gateway that cannot be
 * bypassed — commands receive the gateway via WorkflowContext and call typed
 * check methods before performing any gated operation.
 */

import type {
  StepCapability,
  CapabilityType,
} from '../types/step-command.types.js';
import { enforceScope, formatViolations, VALID_CAPABILITY_TYPES, type CapabilityViolation } from './capability-validator.js';

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

  private enforce(capabilityType: CapabilityType, resource: string): void {
    const violation = enforceScope(this.caps, capabilityType, resource, this.stepId, this.stepType);
    if (violation) {
      throw new CapabilityDeniedError(violation);
    }
  }
}

/** All known capability types, derived from the canonical set in capability-validator. */
const ALL_CAPABILITY_TYPES = [...VALID_CAPABILITY_TYPES] as CapabilityType[];

/** Human-readable descriptions for capability types. */
const CAPABILITY_LABELS: Record<CapabilityType, string> = {
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
export function discloseStep(stepName: string, caps: readonly StepCapability[]): StepDisclosureSummary {
  const grantedTypes = new Set(caps.map(c => c.type));

  const granted: CapabilityDisclosure[] = caps.map(c => ({
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
export function discloseWorkflow(
  workflowName: string,
  steps: ReadonlyArray<{ name: string; caps: readonly StepCapability[] }>,
): WorkflowDisclosureSummary {
  const aggregate = new Map<CapabilityType, string[]>();
  const usedTypes = new Set<CapabilityType>();

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
export function formatStepDisclosure(summary: StepDisclosureSummary): string {
  const lines: string[] = [];

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
export function formatWorkflowDisclosure(summary: WorkflowDisclosureSummary): string {
  const lines: string[] = [];

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
