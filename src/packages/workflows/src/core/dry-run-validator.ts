/**
 * Dry-Run Validator
 *
 * Validates a workflow definition without executing it, reporting what
 * WOULD happen at each step.
 * Extracted from WorkflowRunner (Issue #182).
 */

import type {
  WorkflowContext,
  ValidationError,
  MofloLevel,
} from '../types/step-command.types.js';
import type {
  WorkflowDefinition,
} from '../types/workflow-definition.types.js';
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

/**
 * Validate a workflow without executing — reports what WOULD happen at each step.
 */
export async function dryRunValidate(
  definition: WorkflowDefinition,
  resolvedArgs: Record<string, unknown>,
  defValidation: { valid: boolean; errors: ValidationError[] },
  options: RunnerOptions,
  registry: StepCommandRegistry,
  buildContext: (variables: Record<string, unknown>, workflowId: string, stepIndex: number) => WorkflowContext,
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
  // Build a map: prerequisite name → result
  const prereqByName = new Map(prereqResults.map(r => [r.name, r]));

  const workflowId = `dryrun-${Date.now()}`;
  const variables: Record<string, unknown> = {};
  const stepReports: DryRunStepReport[] = [];

  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    const command = registry.get(step.type);

    let interpolatedConfig: Record<string, unknown> | null = null;
    let validationResult = { valid: true, errors: [] as ValidationError[] };

    if (command) {
      const context = buildContext(variables, workflowId, i);
      try {
        interpolatedConfig = interpolateConfig(
          step.config as Record<string, unknown>,
          context,
        );
      } catch {
        interpolatedConfig = null;
        validationResult = {
          valid: false,
          errors: [{ path: `steps[${i}].config`, message: 'Variable interpolation failed' }],
        };
      }

      if (interpolatedConfig) {
        const vr = await command.validate(interpolatedConfig, context);
        validationResult = { valid: vr.valid, errors: [...vr.errors] };
      }

      // Check capability declarations in dry-run (#161)
      const capCheck = checkCapabilities(step, command);
      if (!capCheck.allowed) {
        validationResult = {
          valid: false,
          errors: [
            ...validationResult.errors,
            ...capCheck.violations.map(v => ({
              path: `steps[${i}].capabilities.${v.capability}`,
              message: v.reason,
            })),
          ],
        };
      }

      if (step.output) {
        variables[step.output] = { _dryRun: true };
      }
    } else {
      validationResult = {
        valid: false,
        errors: [{ path: `steps[${i}].type`, message: `Unknown step type: "${step.type}"` }],
      };
    }

    // Resolve moflo level for dry-run report
    const stepMofloLevel = command
      ? resolveMofloLevel(step, command, definition.mofloLevel, options.parentMofloLevel)
      : undefined;

    // Collect prerequisite results for this step's command (Story #193)
    const stepPrereqResults = command?.prerequisites
      ? command.prerequisites
          .map(p => prereqByName.get(p.name))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
      : undefined;

    stepReports.push({
      stepId: step.id,
      stepType: step.type,
      description: command?.description ?? 'unknown command',
      interpolatedConfig,
      validationResult,
      continueOnError: step.continueOnError ?? false,
      hasRollback: command?.rollback !== undefined,
      mofloLevel: stepMofloLevel,
      prerequisiteResults: stepPrereqResults,
    });
  }

  const allValid =
    defValidation.valid &&
    argErrors.length === 0 &&
    stepReports.every(s => s.validationResult.valid);

  return {
    valid: allValid,
    argumentErrors: argErrors,
    definitionErrors: defValidation.errors,
    steps: stepReports,
  };
}
