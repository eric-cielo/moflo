/**
 * Condition Step Command — branches on expression evaluation.
 *
 * Evaluates a simple expression string against context variables.
 * Returns which branch (then/else) should execute next.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';
import { interpolateString } from '../core/interpolation.js';

/**
 * Evaluate a simple condition expression.
 * Supports: truthy checks, equality (==, !=), comparison (>, <, >=, <=).
 */
function evaluateCondition(expression: string, context: WorkflowContext): boolean {
  const resolved = interpolateString(expression, context);

  // Equality operators
  for (const op of ['!=', '==', '>=', '<=', '>', '<'] as const) {
    const idx = resolved.indexOf(op);
    if (idx !== -1) {
      const left = resolved.slice(0, idx).trim();
      const right = resolved.slice(idx + op.length).trim();
      const leftNum = Number(left);
      const rightNum = Number(right);
      const useNum = !isNaN(leftNum) && !isNaN(rightNum);

      switch (op) {
        case '==': return useNum ? leftNum === rightNum : left === right;
        case '!=': return useNum ? leftNum !== rightNum : left !== right;
        case '>': return useNum ? leftNum > rightNum : left > right;
        case '<': return useNum ? leftNum < rightNum : left < right;
        case '>=': return useNum ? leftNum >= rightNum : left >= right;
        case '<=': return useNum ? leftNum <= rightNum : left <= right;
      }
    }
  }

  // Truthy check
  return resolved !== '' && resolved !== '0' && resolved !== 'false' && resolved !== 'null' && resolved !== 'undefined';
}

export const conditionCommand: StepCommand = {
  type: 'condition',
  description: 'Branch workflow based on expression evaluation',
  configSchema: {
    type: 'object',
    properties: {
      if: { type: 'string', description: 'Expression to evaluate' },
      then: { type: 'string', description: 'Step ID to run if true' },
      else: { type: 'string', description: 'Step ID to run if false' },
    },
    required: ['if'],
  } satisfies JSONSchema,

  validate(config: StepConfig): ValidationResult {
    const errors = [];
    if (!config.if || typeof config.if !== 'string') {
      errors.push({ path: 'if', message: 'if expression is required' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: StepConfig, context: WorkflowContext): Promise<StepOutput> {
    const start = Date.now();
    const expression = config.if as string;
    const result = evaluateCondition(expression, context);
    const nextStep = result
      ? (config.then as string | undefined)
      : (config.else as string | undefined);

    return {
      success: true,
      data: {
        result,
        branch: result ? 'then' : 'else',
        nextStep: nextStep ?? null,
      },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'result', type: 'boolean', required: true },
      { name: 'branch', type: 'string', required: true },
      { name: 'nextStep', type: 'string' },
    ];
  },
};
