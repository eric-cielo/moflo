/**
 * Credential Masker
 *
 * Masks and scans for credential values in workflow step outputs.
 * Extracted from WorkflowRunner (Issue #182).
 */

import type { StepOutput, StepCommand } from '../types/step-command.types.js';
import type { StepDefinition } from '../types/workflow-definition.types.js';

/** Minimum credential length to redact (avoids false-positive redaction). */
export const MIN_REDACT_LENGTH = 4;

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build pre-compiled RegExp patterns from literal credential values.
 * Skips values shorter than MIN_REDACT_LENGTH to avoid false positives (#164).
 */
export function buildCredentialPatterns(credentialValues: readonly string[]): RegExp[] {
  return credentialValues
    .filter(v => v.length >= MIN_REDACT_LENGTH)
    .map(v => new RegExp(escapeRegExp(v), 'g'));
}

/**
 * Add a resolved credential value to the pattern list (if long enough).
 */
export function addCredentialPattern(patterns: RegExp[], value: string): void {
  if (value.length >= MIN_REDACT_LENGTH) {
    patterns.push(new RegExp(escapeRegExp(value), 'g'));
  }
}

/**
 * Mask credential values in step output using pre-compiled patterns.
 */
export function maskCredentials(output: StepOutput, patterns: RegExp[]): StepOutput {
  if (patterns.length === 0) return output;

  const serialized = JSON.stringify(output.data);
  let masked = serialized;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, '***REDACTED***');
  }

  if (masked === serialized) return output;

  // Guard against JSON corruption from partial substring replacement (#164)
  try {
    return {
      ...output,
      data: JSON.parse(masked) as Record<string, unknown>,
    };
  } catch {
    return {
      ...output,
      data: { _redacted: true, _note: 'Output contained credentials and was fully redacted' },
    };
  }
}

/**
 * Scan all step configs (including nested loop steps) for {credentials.NAME} references.
 */
export function collectCredentialNames(steps: readonly StepDefinition[]): Set<string> {
  const names = new Set<string>();

  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{credentials\.([^}]+)\}/g)) {
        names.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) scan(v);
    }
  };

  const scanSteps = (stepsToScan: readonly StepDefinition[]): void => {
    for (const step of stepsToScan) {
      scan(step.config);
      if (step.steps) scanSteps(step.steps);
    }
  };

  scanSteps(steps);
  return names;
}

/**
 * Check if a step's raw config contains {credentials.*} references.
 */
export function stepReferencesCredentials(step: StepDefinition): boolean {
  return collectCredentialNames([step]).size > 0;
}

/**
 * Check if a step has the 'credentials' capability via the command's defaults.
 */
export function stepHasCredentialCapability(_step: StepDefinition, command: StepCommand): boolean {
  return command.capabilities?.some(c => c.type === 'credentials') ?? false;
}
