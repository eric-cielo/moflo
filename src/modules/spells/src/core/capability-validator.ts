/**
 * Capability Validator
 *
 * Story #108: Tier 1 capability declaration and enforcement.
 * Each step command declares required capabilities. Spell YAML can further
 * restrict (never expand) capabilities per step. The runner checks capabilities
 * before execution and blocks undeclared access.
 */

import type { StepCapability, CapabilityType, StepCommand, MofloLevel } from '../types/step-command.types.js';
import { MOFLO_LEVEL_ORDER } from '../types/step-command.types.js';
import type { StepDefinition } from '../types/spell-definition.types.js';

// ── Types ─────────────────────────────────────────────────────────────────

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

export const VALID_CAPABILITY_TYPES: ReadonlySet<string> = new Set<CapabilityType>([
  'fs:read', 'fs:write', 'net', 'shell', 'memory', 'credentials', 'browser', 'browser:evaluate', 'agent',
]);

// ── Core validation ───────────────────────────────────────────────────────

/**
 * Check whether a step is allowed to execute given its command's declared
 * capabilities and any per-step restrictions from the spell YAML.
 *
 * Restrictions in YAML can only **narrow** the command's defaults — they
 * cannot grant new capability types the command doesn't declare.
 */
export function checkCapabilities(
  step: StepDefinition,
  command: StepCommand,
): CapabilityCheckResult {
  const commandCaps = command.capabilities ?? [];
  const violations: CapabilityViolation[] = [];

  if (!step.capabilities) {
    return { allowed: true, violations: [], effectiveCaps: commandCaps };
  }

  const stepRestrictions = step.capabilities;
  const commandCapTypes = new Set(commandCaps.map(c => c.type));
  const effectiveCaps: StepCapability[] = [];

  for (const [capType, scope] of Object.entries(stepRestrictions)) {
    if (!isValidCapabilityType(capType)) {
      violations.push({
        capability: capType as CapabilityType,
        reason: `unknown capability type: "${capType}"`,
        stepId: step.id,
        stepType: step.type,
      });
      continue;
    }

    if (!commandCapTypes.has(capType as CapabilityType)) {
      violations.push({
        capability: capType as CapabilityType,
        reason: `step type "${step.type}" does not declare capability "${capType}" — cannot grant new capabilities`,
        stepId: step.id,
        stepType: step.type,
      });
      continue;
    }

    effectiveCaps.push({
      type: capType as CapabilityType,
      scope: Array.isArray(scope) ? scope : undefined,
    });
  }

  // Add command capabilities that weren't overridden by step restrictions
  for (const cap of commandCaps) {
    if (!Object.hasOwn(stepRestrictions, cap.type)) {
      effectiveCaps.push(cap);
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    effectiveCaps,
  };
}

/**
 * Validate that a capability type string is a known type.
 */
export function isValidCapabilityType(type: string): type is CapabilityType {
  return VALID_CAPABILITY_TYPES.has(type);
}

/**
 * Validate step capabilities in a spell definition (for schema validation).
 */
export function validateStepCapabilities(
  step: StepDefinition,
  path: string,
): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];

  if (step.capabilities === undefined) return errors;

  if (typeof step.capabilities !== 'object' || Array.isArray(step.capabilities) || step.capabilities === null) {
    errors.push({
      path: `${path}.capabilities`,
      message: 'capabilities must be an object mapping capability types to scope arrays',
    });
    return errors;
  }

  for (const [capType, scope] of Object.entries(step.capabilities)) {
    if (!isValidCapabilityType(capType)) {
      errors.push({
        path: `${path}.capabilities.${capType}`,
        message: `unknown capability type: "${capType}". Valid types: ${[...VALID_CAPABILITY_TYPES].join(', ')}`,
      });
    }
    if (!Array.isArray(scope)) {
      errors.push({
        path: `${path}.capabilities.${capType}`,
        message: `scope must be an array of strings`,
      });
    } else if (!scope.every(s => typeof s === 'string')) {
      errors.push({
        path: `${path}.capabilities.${capType}`,
        message: `all scope values must be strings`,
      });
    }
  }

  return errors;
}

/**
 * Enforce scope restrictions at runtime.
 *
 * Call this from command.execute() to verify that a requested resource
 * falls within the effective scope. Returns null if allowed, or a
 * violation object if the resource is outside the permitted scope.
 *
 * If no scope is defined for the capability type, access is unrestricted.
 */
export function enforceScope(
  effectiveCaps: readonly StepCapability[],
  capabilityType: CapabilityType,
  resource: string,
  stepId: string,
  stepType: string,
): CapabilityViolation | null {
  const cap = effectiveCaps.find(c => c.type === capabilityType);
  if (!cap) {
    return {
      capability: capabilityType,
      reason: `capability "${capabilityType}" not granted`,
      stepId,
      stepType,
    };
  }

  // No scope defined = unrestricted access within this capability
  if (!cap.scope || cap.scope.length === 0) {
    return null;
  }

  // Check if the resource matches any of the allowed scope patterns
  const normalizedResource = resource.replace(/\\/g, '/');
  const allowed = cap.scope.some(pattern => {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    // Exact match or prefix match (directory scope)
    return normalizedResource === normalizedPattern
      || normalizedResource.startsWith(normalizedPattern);
  });

  if (!allowed) {
    return {
      capability: capabilityType,
      reason: `resource "${resource}" is outside allowed scope: [${cap.scope.join(', ')}]`,
      stepId,
      stepType,
    };
  }

  return null;
}

/**
 * Format capability violations into a human-readable error message.
 */
export function formatViolations(violations: readonly CapabilityViolation[]): string {
  return violations.map(v => `[${v.capability}] ${v.reason}`).join('; ');
}

// ── MoFlo Integration Levels ─────────────────────────────────────────────

const VALID_MOFLO_LEVELS: ReadonlySet<string> = new Set<MofloLevel>(MOFLO_LEVEL_ORDER);

/**
 * Check if a string is a valid MofloLevel.
 */
export function isValidMofloLevel(level: string): level is MofloLevel {
  return VALID_MOFLO_LEVELS.has(level);
}

/**
 * Compare two MoFlo levels. Returns:
 *  - negative if a < b (a is less permissive)
 *  - 0 if equal
 *  - positive if a > b (a is more permissive)
 */
export function compareMofloLevels(a: MofloLevel, b: MofloLevel): number {
  return MOFLO_LEVEL_ORDER.indexOf(a) - MOFLO_LEVEL_ORDER.indexOf(b);
}

/**
 * Get the default MoFlo integration level for a step type.
 * The command's `defaultMofloLevel` is the authoritative source;
 * falls back to 'none' when no command is available.
 */
export function getDefaultMofloLevel(_stepType: string, command?: StepCommand): MofloLevel {
  return command?.defaultMofloLevel ?? 'none';
}

/**
 * Resolve the effective MoFlo level for a step given spell defaults,
 * step overrides, command defaults, and parent constraints.
 *
 * Resolution order (most specific wins, but can only narrow):
 * 1. Command declares its default level
 * 2. Spell definition may set a spell-wide level
 * 3. Step may override with its own level (must not exceed spell level)
 * 4. Parent spell constrains the maximum level (for recursive invocation)
 */
export function resolveMofloLevel(
  step: StepDefinition,
  command: StepCommand | undefined,
  spellLevel: MofloLevel | undefined,
  parentLevel: MofloLevel | undefined,
): MofloLevel {
  const commandDefault = getDefaultMofloLevel(step.type, command);
  const wfLevel = spellLevel ?? commandDefault;

  // Step can narrow but not exceed the spell-level default
  let effective: MofloLevel;
  if (step.mofloLevel) {
    effective = compareMofloLevels(step.mofloLevel, wfLevel) <= 0
      ? step.mofloLevel
      : wfLevel; // Capped at spell level
  } else {
    // Use the more restrictive of spell level and command default
    effective = compareMofloLevels(commandDefault, wfLevel) <= 0
      ? commandDefault
      : wfLevel;
  }

  // Parent constraint: child cannot exceed parent's level
  if (parentLevel && compareMofloLevels(effective, parentLevel) > 0) {
    effective = parentLevel;
  }

  return effective;
}
