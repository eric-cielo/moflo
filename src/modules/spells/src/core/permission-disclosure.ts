/**
 * Permission Disclosure
 *
 * Analyzes spell definitions and produces human-readable permission reports
 * showing what each step requires and highlighting destructive capabilities.
 *
 * Used by:
 *   - Dry-run output (always shows full permission details)
 *   - Spell-builder / connector-builder skills (displays on step creation)
 *   - Acceptance gate (generates hash for change detection)
 *
 * Builds on capability-disclosure.ts (transparency) and permission-resolver.ts
 * (least-privilege). This module bridges the two: it resolves what level each
 * step gets and flags which capabilities are dangerous.
 */

import type {
  StepCapability,
  CapabilityType,
} from '../types/step-command.types.js';
import type { StepDefinition, SpellDefinition } from '../types/spell-definition.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';
import {
  resolvePermissions,
  type PermissionLevel,
  type ResolvedPermissions,
} from './permission-resolver.js';
import { checkCapabilities } from './capability-validator.js';
import { createHash } from 'node:crypto';

// ============================================================================
// Risk Classification
// ============================================================================

/**
 * Risk levels shown to users during permission disclosure.
 *
 *   none     — No external side effects (condition, memory read)
 *   low      — Can read external data or spawn sub-agents
 *   moderate — Can make network requests or control browsers
 *   higher   — Can modify files, run shell commands, or access credentials
 */
export type RiskLevel = 'none' | 'low' | 'moderate' | 'higher';

/**
 * Capabilities classified as higher-risk — can permanently modify or delete
 * data, spawn processes, or access credentials. Users must be made aware.
 */
const HIGHER_RISK_CAPABILITIES: ReadonlySet<CapabilityType> = new Set([
  'shell',
  'fs:write',
  'browser:evaluate',
  'credentials',
]);

/**
 * Capabilities classified as moderate-risk — can read private data or spawn
 * autonomous processes. Worth calling out but not directly destructive.
 */
const MODERATE_RISK_CAPABILITIES: ReadonlySet<CapabilityType> = new Set([
  'agent',
  'net',
  'browser',
]);

/** Human-readable risk explanations for each capability. */
const RISK_EXPLANATIONS: Partial<Record<CapabilityType, string>> = {
  'shell': 'Runs shell commands on your machine',
  'fs:write': 'Creates, overwrites, or deletes files',
  'browser:evaluate': 'Executes JavaScript in a browser context',
  'credentials': 'Accesses stored secrets and API keys',
  'agent': 'Spawns autonomous AI sub-agents',
  'net': 'Makes network requests to external services',
  'browser': 'Launches and controls browser sessions',
};

// ============================================================================
// Per-Step Permission Report
// ============================================================================

export interface StepPermissionReport {
  readonly stepId: string;
  readonly stepType: string;
  /** The resolved permission level for this step. */
  readonly permissionLevel: PermissionLevel;
  /** The resolved CLI permissions (tools list, flags). */
  readonly resolved: ResolvedPermissions;
  /** Effective capabilities after merging command defaults with YAML restrictions. */
  readonly effectiveCaps: readonly StepCapability[];
  /** Overall risk level for this step. */
  readonly riskLevel: RiskLevel;
  /** Specific destructive or sensitive warnings. */
  readonly warnings: readonly PermissionWarning[];
}

export interface PermissionWarning {
  readonly capability: CapabilityType;
  readonly riskLevel: 'moderate' | 'higher';
  readonly explanation: string;
  /** Scope restriction (if any) — narrows the risk. */
  readonly scope?: readonly string[];
}

// ============================================================================
// Spell-Level Permission Report
// ============================================================================

export interface SpellPermissionReport {
  readonly spellName: string;
  readonly steps: readonly StepPermissionReport[];
  /** Highest risk level across all steps. */
  readonly overallRisk: RiskLevel;
  /** All destructive/sensitive warnings across all steps. */
  readonly allWarnings: readonly PermissionWarning[];
  /** SHA-256 hash of the permission profile — changes when permissions change. */
  readonly permissionHash: string;
}

// ============================================================================
// Analysis Functions
// ============================================================================

/**
 * Analyze a single step's permissions and produce a report.
 */
export function analyzeStepPermissions(
  step: StepDefinition,
  registry: StepCommandRegistry,
): StepPermissionReport {
  const command = registry.get(step.type);
  let effectiveCaps: readonly StepCapability[] = [];

  if (command) {
    const capCheck = checkCapabilities(step, command);
    effectiveCaps = capCheck.effectiveCaps;
  }

  const resolved = resolvePermissions(step.permissionLevel, effectiveCaps);
  const warnings = classifyCapabilities(effectiveCaps);
  const riskLevel = computeRiskLevel(warnings);

  return {
    stepId: step.id,
    stepType: step.type,
    permissionLevel: resolved.level,
    resolved,
    effectiveCaps,
    riskLevel,
    warnings,
  };
}

/**
 * Analyze an entire spell's permissions and produce a comprehensive report.
 */
export function analyzeSpellPermissions(
  definition: SpellDefinition,
  registry: StepCommandRegistry,
): SpellPermissionReport {
  const steps: StepPermissionReport[] = [];

  function analyzeSteps(stepDefs: readonly StepDefinition[]): void {
    for (const step of stepDefs) {
      steps.push(analyzeStepPermissions(step, registry));
      if (step.steps) analyzeSteps(step.steps);
    }
  }

  analyzeSteps(definition.steps);

  const allWarnings = steps.flatMap(s => s.warnings);
  const overallRisk = computeRiskLevel(allWarnings);
  const permissionHash = computePermissionHash(steps);

  return {
    spellName: definition.name,
    steps,
    overallRisk,
    allWarnings,
    permissionHash,
  };
}

// ============================================================================
// Classification
// ============================================================================

function classifyCapabilities(caps: readonly StepCapability[]): PermissionWarning[] {
  const warnings: PermissionWarning[] = [];

  for (const cap of caps) {
    if (HIGHER_RISK_CAPABILITIES.has(cap.type)) {
      warnings.push({
        capability: cap.type,
        riskLevel: 'higher',
        explanation: RISK_EXPLANATIONS[cap.type] ?? `Has ${cap.type} access`,
        scope: cap.scope,
      });
    } else if (MODERATE_RISK_CAPABILITIES.has(cap.type)) {
      warnings.push({
        capability: cap.type,
        riskLevel: 'moderate',
        explanation: RISK_EXPLANATIONS[cap.type] ?? `Has ${cap.type} access`,
        scope: cap.scope,
      });
    }
  }

  return warnings;
}

function computeRiskLevel(warnings: readonly PermissionWarning[]): RiskLevel {
  if (warnings.some(w => w.riskLevel === 'higher')) return 'higher';
  if (warnings.some(w => w.riskLevel === 'moderate')) return 'moderate';
  return 'none';
}

// ============================================================================
// Permission Hash (for acceptance tracking)
// ============================================================================

/**
 * Compute a SHA-256 hash of the spell's permission profile.
 * Changes when:
 *   - A step's permission level changes
 *   - Effective capabilities change (new caps added, scope changed)
 *   - Steps are added or removed
 * Does NOT change when non-permission fields change (prompt text, timeouts, etc.).
 */
function computePermissionHash(steps: readonly StepPermissionReport[]): string {
  const hashInput = steps.map(s => ({
    id: s.stepId,
    type: s.stepType,
    level: s.permissionLevel,
    caps: [...s.effectiveCaps].sort((a, b) => a.type.localeCompare(b.type)).map(c => ({
      type: c.type,
      scope: c.scope ? [...c.scope].sort() : undefined,
    })),
  }));

  return createHash('sha256')
    .update(JSON.stringify(hashInput))
    .digest('hex')
    .slice(0, 16); // 16-char prefix is sufficient for change detection
}

// ============================================================================
// Formatting — Human-Readable Output
// ============================================================================

const RISK_LABELS: Record<RiskLevel, string> = {
  none: '[No risk]',
  low: '[Low risk]',
  moderate: '[Moderate risk]',
  higher: '[Higher risk]',
};

/**
 * Format a single step's permission report for display.
 */
export function formatStepPermissionReport(report: StepPermissionReport): string {
  const lines: string[] = [];
  const label = RISK_LABELS[report.riskLevel];

  lines.push(`  ${label} ${report.stepId} (${report.stepType})`);
  lines.push(`    Permission level: ${report.permissionLevel}`);

  if (report.resolved.allowedTools) {
    lines.push(`    Allowed tools: ${report.resolved.allowedTools.join(', ')}`);
  } else {
    lines.push(`    Allowed tools: ALL (autonomous)`);
  }

  if (report.warnings.length > 0) {
    for (const w of report.warnings) {
      const scopeNote = w.scope?.length
        ? ` (scoped to: ${w.scope.join(', ')})`
        : '';
      lines.push(`    - ${w.capability}: ${w.explanation}${scopeNote}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a full spell permission report for display.
 * Used by dry-run output and spell-builder skill.
 */
export function formatSpellPermissionReport(report: SpellPermissionReport): string {
  const lines: string[] = [];

  lines.push(`--- Risk Analysis: ${report.spellName} ---`);
  lines.push(`Overall: ${RISK_LABELS[report.overallRisk]}`);
  lines.push(`Permission hash: ${report.permissionHash}`);
  lines.push('');

  for (const step of report.steps) {
    lines.push(formatStepPermissionReport(step));
    lines.push('');
  }

  if (report.overallRisk === 'higher' || report.overallRisk === 'moderate') {
    const riskySteps = report.steps.filter(
      s => s.riskLevel === 'higher' || s.riskLevel === 'moderate',
    );
    lines.push(`--- ${riskySteps.length} step(s) require elevated permissions ---`);
    for (const s of riskySteps) {
      const caps = s.warnings.map(w => w.capability);
      lines.push(`  - ${s.stepId}: ${caps.join(', ')}`);
    }
    lines.push('');
    lines.push('These steps can modify files, run shell commands, or access credentials.');
    lines.push('Review the spell definition before accepting.');
  }

  return lines.join('\n');
}
