/**
 * Dry-Run Validator
 *
 * Validates a spell definition without executing it, reporting what
 * WOULD happen at each step.
 * Extracted from SpellCaster (Issue #182).
 */

import type {
  CastingContext,
  ValidationError,
  MofloLevel,
  PrerequisiteResult,
} from '../types/step-command.types.js';
import type {
  SpellDefinition,
  StepDefinition,
} from '../types/spell-definition.types.js';
import type {
  DryRunResult,
  DryRunStepReport,
  RunnerOptions,
} from '../types/runner.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';
import { interpolateConfig } from './interpolation.js';
import { resolveArguments } from '../schema/validator.js';
import {
  checkCapabilities,
  resolveMofloLevel,
} from './capability-validator.js';
import { collectPrerequisites, checkPrerequisites } from './prerequisite-checker.js';
import { analyzeStepPermissions, analyzeSpellPermissions } from './permission-disclosure.js';

/** Invariant context shared across all `dryRunValidateStep` calls within a single dry-run. */
interface DryRunEnv {
  readonly registry: StepCommandRegistry;
  readonly definition: SpellDefinition;
  readonly options: RunnerOptions;
  readonly prereqByName: Map<string, PrerequisiteResult>;
}

/**
 * Validate a single step for dry-run, returning a report of what WOULD happen.
 *
 * Shared by the main loop, parallel nested steps, and loop nested steps (#252).
 */
async function dryRunValidateStep(
  step: StepDefinition,
  stepPath: string,
  context: CastingContext,
  env: DryRunEnv,
): Promise<DryRunStepReport> {
  const command = env.registry.get(step.type);

  let interpolatedConfig: Record<string, unknown> | null = null;
  let validationResult = { valid: true, errors: [] as ValidationError[] };

  if (command) {
    try {
      interpolatedConfig = interpolateConfig(
        step.config as Record<string, unknown>,
        context,
      );
    } catch {
      interpolatedConfig = null;
      validationResult = {
        valid: false,
        errors: [{ path: `${stepPath}.config`, message: 'Variable interpolation failed' }],
      };
    }

    if (interpolatedConfig) {
      const vr = await command.validate(interpolatedConfig, context);
      validationResult = { valid: vr.valid, errors: [...vr.errors] };
    }

    const capCheck = checkCapabilities(step, command);
    if (!capCheck.allowed) {
      validationResult = {
        valid: false,
        errors: [
          ...validationResult.errors,
          ...capCheck.violations.map(v => ({
            path: `${stepPath}.capabilities.${v.capability}`,
            message: v.reason,
          })),
        ],
      };
    }
  } else {
    validationResult = {
      valid: false,
      errors: [{ path: `${stepPath}.type`, message: `Unknown step type: "${step.type}"` }],
    };
  }

  const mofloLevel = command
    ? resolveMofloLevel(step, command, env.definition.mofloLevel, env.options.parentMofloLevel)
    : undefined;

  const prerequisiteResults = command?.prerequisites
    ? command.prerequisites
        .map(p => env.prereqByName.get(p.name))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
    : undefined;

  // Analyze permissions for this step
  const permReport = analyzeStepPermissions(step, env.registry);

  // Detect destructive overrides for dry-run visibility (#419)
  const destructiveOverride = resolveDestructiveOverride(interpolatedConfig);

  return {
    stepId: step.id,
    stepType: step.type,
    description: command?.description ?? 'unknown command',
    interpolatedConfig,
    validationResult,
    continueOnError: step.continueOnError ?? false,
    hasRollback: command?.rollback !== undefined,
    mofloLevel,
    prerequisiteResults,
    permissionLevel: permReport.permissionLevel,
    resolvedPermissions: permReport.resolved,
    riskLevel: permReport.riskLevel,
    permissionWarnings: permReport.warnings,
    destructiveOverride,
  };
}

/**
 * Validate a spell without executing — reports what WOULD happen at each step.
 */
export async function dryRunValidate(
  definition: SpellDefinition,
  resolvedArgs: Record<string, unknown>,
  defValidation: { valid: boolean; errors: ValidationError[] },
  options: RunnerOptions,
  registry: StepCommandRegistry,
  buildContext: (variables: Record<string, unknown>, spellId: string, stepIndex: number) => CastingContext,
): Promise<DryRunResult> {
  const argErrors: ValidationError[] = [];
  if (definition.arguments) {
    const { errors } = resolveArguments(definition.arguments, resolvedArgs);
    argErrors.push(...errors);
  }

  // Check all prerequisites upfront (Story #193)
  const allPrereqs = collectPrerequisites(definition, registry);
  const prereqResults = allPrereqs.length > 0
    ? await checkPrerequisites(allPrereqs)
    : [];
  const prereqByName = new Map(prereqResults.map(r => [r.name, r]));

  const spellId = `dryrun-${Date.now()}`;
  const variables: Record<string, unknown> = {};
  const stepReports: DryRunStepReport[] = [];
  const env: DryRunEnv = { registry, definition, options, prereqByName };

  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    const context = buildContext(variables, spellId, i);

    const report = await dryRunValidateStep(step, `steps[${i}]`, context, env);
    stepReports.push(report);

    if (step.output && report.validationResult.valid) {
      variables[step.output] = { _dryRun: true };
    }

    // Validate nested steps for parallel and loop blocks (#247, #252)
    if ((step.type === 'parallel' || step.type === 'loop') && step.steps && step.steps.length > 0) {
      // For loop steps, inject mock loop context so {loop.*} references resolve
      if (step.type === 'loop') {
        const itemVar = (step.config as Record<string, unknown>)?.itemVar as string ?? 'item';
        variables['loop'] = { [itemVar]: '_dryRun_placeholder', index: 0 };
      }

      for (let j = 0; j < step.steps.length; j++) {
        const nested = step.steps[j];
        const nestedContext = buildContext(variables, spellId, i);

        const nestedReport = await dryRunValidateStep(nested, `steps[${i}].steps[${j}]`, nestedContext, env);
        stepReports.push(nestedReport);

        if (nested.output && nestedReport.validationResult.valid) {
          variables[nested.output] = { _dryRun: true };
        }
        if (nestedReport.validationResult.valid) {
          variables[nested.id] = { _dryRun: true };
        }
      }
    }
  }

  const allValid =
    defValidation.valid &&
    argErrors.length === 0 &&
    stepReports.every(s => s.validationResult.valid);

  // Compute spell-level permission summary
  const spellPermissions = analyzeSpellPermissions(definition, registry);

  return {
    valid: allValid,
    argumentErrors: argErrors,
    definitionErrors: defValidation.errors,
    steps: stepReports,
    permissionHash: spellPermissions.permissionHash,
    overallRisk: spellPermissions.overallRisk,
  };
}

// ── Destructive override detection (#419) ───────────────────────────────

function resolveDestructiveOverride(
  config: Record<string, unknown> | null,
): DryRunStepReport['destructiveOverride'] {
  if (!config) return undefined;
  const ad = config.allowDestructive;
  if (ad === true) {
    return { type: 'boolean', deprecated: true };
  }
  if (Array.isArray(ad) && ad.length > 0) {
    return { type: 'scoped', scope: ad as string[] };
  }
  return undefined;
}
