/**
 * Step validation.
 *
 * Recursively validates the `steps:` tree: duplicate IDs, unknown step types,
 * capability / moflo-level / permission-level coherence, step-level
 * `prerequisites:` and `preflight:` specs, and parallel-block cross-references.
 *
 * Step-level `prerequisites:` delegates to `./prerequisites.js`.
 * Parallel cross-reference checks delegate to `./references.js`.
 */

import type { ValidationError } from '../../types/step-command.types.js';
import type { MofloLevel } from '../../types/step-command.types.js';
import type { StepDefinition } from '../../types/spell-definition.types.js';
import {
  validateStepCapabilities,
  isValidMofloLevel,
  compareMofloLevels,
} from '../../core/capability-validator.js';
import { MOFLO_LEVEL_ORDER } from '../../types/step-command.types.js';
import { isValidPermissionLevel, VALID_PERMISSION_LEVELS } from '../../core/permission-resolver.js';
import { validatePrerequisites } from './prerequisites.js';
import { validateParallelCrossReferences } from './references.js';
import type { ValidatorOptions } from '../validator.js';

export function validateSteps(
  steps: readonly StepDefinition[],
  errors: ValidationError[],
  stepIds: Set<string>,
  outputVars: Set<string>,
  options?: ValidatorOptions,
  prefix = 'steps',
  spellLevel?: MofloLevel,
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${prefix}[${i}]`;

    if (!step.id || typeof step.id !== 'string') {
      errors.push({ path: `${path}.id`, message: 'step id is required' });
    } else if (stepIds.has(step.id)) {
      errors.push({ path: `${path}.id`, message: `duplicate step id: "${step.id}"` });
    } else {
      stepIds.add(step.id);
    }

    if (!step.type || typeof step.type !== 'string') {
      errors.push({ path: `${path}.type`, message: 'step type is required' });
    } else if (options?.knownStepTypes && !options.knownStepTypes.includes(step.type)) {
      const suggestions = findSimilar(step.type, options.knownStepTypes);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      errors.push({
        path: `${path}.type`,
        message: `unknown step type: "${step.type}".${hint}`,
      });
    }

    if (step.output) {
      outputVars.add(step.output);
    }

    const capErrors = validateStepCapabilities(step, path);
    errors.push(...capErrors);

    if (step.mofloLevel !== undefined) {
      if (!isValidMofloLevel(step.mofloLevel)) {
        errors.push({
          path: `${path}.mofloLevel`,
          message: `invalid mofloLevel: "${step.mofloLevel}". Valid levels: ${MOFLO_LEVEL_ORDER.join(', ')}`,
        });
      } else if (spellLevel && compareMofloLevels(step.mofloLevel, spellLevel) > 0) {
        errors.push({
          path: `${path}.mofloLevel`,
          message: `step mofloLevel "${step.mofloLevel}" exceeds spell-level "${spellLevel}" — steps can only narrow, not escalate`,
        });
      }
    }

    if (step.permissionLevel !== undefined && !isValidPermissionLevel(step.permissionLevel)) {
      errors.push({
        path: `${path}.permissionLevel`,
        message: `invalid permissionLevel: "${step.permissionLevel}". Valid levels: ${VALID_PERMISSION_LEVELS.join(', ')}`,
      });
    }

    if (step.prerequisites !== undefined) {
      validatePrerequisites(step.prerequisites, errors, `${path}.prerequisites`);
    }

    if (step.preflight !== undefined) {
      validatePreflight(step.preflight, errors, `${path}.preflight`);
    }

    if (step.steps && Array.isArray(step.steps)) {
      validateSteps(step.steps, errors, stepIds, outputVars, options, `${path}.steps`, spellLevel);

      // Parallel blocks: reject cross-references between sibling steps (#247)
      if (step.type === 'parallel') {
        validateParallelCrossReferences(step.steps, errors, `${path}.steps`);
      }
    }
  }
}

function validatePreflight(
  preflight: unknown,
  errors: ValidationError[],
  path: string,
): void {
  if (!Array.isArray(preflight)) {
    errors.push({ path, message: 'preflight must be an array' });
    return;
  }

  preflight.forEach((pf, pi) => {
    const pfPath = `${path}[${pi}]`;
    if (!pf || typeof pf !== 'object') {
      errors.push({ path: pfPath, message: 'preflight entry must be an object' });
      return;
    }
    if (typeof pf.name !== 'string' || pf.name.length === 0) {
      errors.push({ path: `${pfPath}.name`, message: 'preflight.name is required' });
    }
    if (typeof pf.command !== 'string' || pf.command.length === 0) {
      errors.push({ path: `${pfPath}.command`, message: 'preflight.command is required' });
    }
    if (pf.expectExitCode !== undefined && typeof pf.expectExitCode !== 'number') {
      errors.push({ path: `${pfPath}.expectExitCode`, message: 'expectExitCode must be a number' });
    }
    if (pf.timeoutMs !== undefined && (typeof pf.timeoutMs !== 'number' || pf.timeoutMs <= 0)) {
      errors.push({ path: `${pfPath}.timeoutMs`, message: 'timeoutMs must be a positive number' });
    }
    if (pf.hint !== undefined && typeof pf.hint !== 'string') {
      errors.push({ path: `${pfPath}.hint`, message: 'hint must be a string' });
    }
    if (pf.severity !== undefined && pf.severity !== 'fatal' && pf.severity !== 'warning') {
      errors.push({ path: `${pfPath}.severity`, message: 'severity must be "fatal" or "warning"' });
    }
    if (pf.resolutions !== undefined) {
      validatePreflightResolutions(pf.resolutions, errors, `${pfPath}.resolutions`);
    }
  });
}

function validatePreflightResolutions(
  resolutions: unknown,
  errors: ValidationError[],
  path: string,
): void {
  if (!Array.isArray(resolutions)) {
    errors.push({ path, message: 'resolutions must be an array' });
    return;
  }

  resolutions.forEach((r: Record<string, unknown>, ri: number) => {
    const rPath = `${path}[${ri}]`;
    if (!r || typeof r !== 'object') {
      errors.push({ path: rPath, message: 'resolution must be an object' });
      return;
    }
    if (typeof r.label !== 'string' || (r.label as string).length === 0) {
      errors.push({ path: `${rPath}.label`, message: 'resolution.label is required' });
    }
    if (r.command !== undefined && typeof r.command !== 'string') {
      errors.push({ path: `${rPath}.command`, message: 'resolution.command must be a string' });
    }
    if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== 'number' || (r.timeoutMs as number) <= 0)) {
      errors.push({ path: `${rPath}.timeoutMs`, message: 'resolution.timeoutMs must be a positive number' });
    }
  });
}

function findSimilar(target: string, candidates: readonly string[]): string[] {
  return candidates
    .filter(c => {
      // Simple check: shares at least 3 characters or starts with same prefix
      const common = [...target].filter(ch => c.includes(ch)).length;
      return common >= 3 || c.startsWith(target.slice(0, 3));
    })
    .slice(0, 3);
}
