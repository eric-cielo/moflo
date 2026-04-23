/**
 * Variable reference validation.
 *
 * Walks `{stepId.outputKey}` / `{args.key}` references inside step configs to
 * catch forward references and undefined arguments. Also rejects cross-references
 * between siblings of a `parallel` block (#247) since their order is undefined.
 */

import type { ValidationError } from '../../types/step-command.types.js';
import type {
  StepDefinition,
  ArgumentDefinition,
} from '../../types/spell-definition.types.js';
import { VAR_REF_PATTERN } from '../../core/interpolation.js';

/**
 * Check that {stepId.outputKey} references point to declared step outputs.
 * Also detects forward references (referencing a step that hasn't executed yet).
 */
export function validateVariableReferences(
  steps: readonly StepDefinition[],
  outputVars: Set<string>,
  args: Record<string, ArgumentDefinition> | undefined,
  errors: ValidationError[],
  prefix = 'steps',
  parentDeclaredStepIds: readonly string[] = [],
): void {
  // Nested steps can reference parent-scope declarations (e.g. a loop body
  // referencing an output declared before the loop).
  const declaredStepIds: string[] = [...parentDeclaredStepIds];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${prefix}[${i}]`;

    if (step.config) {
      for (const [key, value] of Object.entries(step.config)) {
        if (typeof value === 'string') {
          checkStringReferences(value, declaredStepIds, args, errors, `${path}.config.${key}`);
        }
      }
    }

    if (step.id) {
      declaredStepIds.push(step.id);
    }
    if (step.output && typeof step.output === 'string' && step.output !== step.id) {
      declaredStepIds.push(step.output);
    }

    // Recurse into nested steps (condition/loop bodies)
    if (step.steps && Array.isArray(step.steps)) {
      validateVariableReferences(step.steps, outputVars, args, errors, `${path}.steps`, declaredStepIds);

      // Parallel/loop nested step IDs are available to subsequent top-level steps (#247)
      for (const nested of step.steps) {
        if (nested.id) declaredStepIds.push(nested.id);
      }
    }
  }
}

function checkStringReferences(
  value: string,
  declaredStepIds: string[],
  args: Record<string, ArgumentDefinition> | undefined,
  errors: ValidationError[],
  path: string,
): void {
  VAR_REF_PATTERN.lastIndex = 0;
  let match;
  while ((match = VAR_REF_PATTERN.exec(value)) !== null) {
    const ref = match[1];
    const segments = ref.split('.');

    // {args.key} — check arg is defined
    if (segments[0] === 'args' && segments.length === 2) {
      if (args && !args[segments[1]]) {
        errors.push({
          path,
          message: `references undefined argument: "${segments[1]}"`,
        });
      }
      continue;
    }

    // {credentials.NAME} — resolved at runtime by the runner
    if (segments[0] === 'credentials' && segments.length === 2) {
      continue;
    }

    // {env.KEY} — resolved at runtime from process.env, typically populated
    // by a spell-level `prerequisites:` entry with promptOnMissing: true.
    if (segments[0] === 'env' && segments.length === 2) {
      continue;
    }

    // {loop.varName} — resolved at runtime by the loop executor
    if (segments[0] === 'loop') {
      continue;
    }

    // {stepId.outputKey} — check step has been declared before this point
    if (segments.length >= 2) {
      const stepId = segments[0];
      if (!declaredStepIds.includes(stepId)) {
        errors.push({
          path,
          message: `references step "${stepId}" which has not been declared yet (forward reference)`,
        });
      }
    }
  }
}

/**
 * Reject variable references between sibling steps within a parallel block.
 * Steps in a parallel block execute concurrently, so they cannot depend on
 * each other's outputs (execution order is undefined).
 */
export function validateParallelCrossReferences(
  steps: readonly StepDefinition[],
  errors: ValidationError[],
  prefix: string,
): void {
  const siblingIds = new Set<string>();
  for (const step of steps) {
    if (step.id) siblingIds.add(step.id);
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const path = `${prefix}[${i}]`;
    if (!step.config) continue;

    for (const [key, value] of Object.entries(step.config)) {
      if (typeof value !== 'string') continue;
      VAR_REF_PATTERN.lastIndex = 0;
      let match;
      while ((match = VAR_REF_PATTERN.exec(value)) !== null) {
        const ref = match[1];
        const segments = ref.split('.');
        if (
          segments.length >= 2
          && segments[0] !== 'args'
          && segments[0] !== 'credentials'
          && segments[0] !== 'env'
        ) {
          if (siblingIds.has(segments[0]) && segments[0] !== step.id) {
            errors.push({
              path: `${path}.config.${key}`,
              message: `parallel step "${step.id}" references sibling step "${segments[0]}" — steps within a parallel block cannot reference each other's outputs`,
            });
          }
        }
      }
    }
  }
}
