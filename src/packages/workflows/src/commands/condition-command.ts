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
 * Ordered operator definitions. Two-char operators are checked first to avoid
 * ambiguity (e.g. `>=` must not be split as `>` + `=…`).
 */
const OPERATORS = ['!=', '==', '>=', '<=', '>', '<'] as const;
type Operator = (typeof OPERATORS)[number];

/**
 * Find the best operator split point in the resolved expression.
 *
 * Strategy: scan for two-char operators first, then single-char. For each
 * operator, we find the *last* occurrence so that values containing operator
 * characters on the left side are less likely to cause a mis-split.
 * We skip matches that would leave an empty left-hand side.
 */
function findOperator(resolved: string): { op: Operator; idx: number } | null {
  for (const op of OPERATORS) {
    const idx = resolved.lastIndexOf(op);
    if (idx > 0) {
      // Ensure two-char ops aren't shadowed: if we matched a single-char op
      // that is part of a two-char op at the same position, skip it.
      if (op.length === 1) {
        const after = resolved[idx + 1];
        // Skip bare > or < if they're part of >= or <=
        if (after === '=') continue;
      }
      return { op, idx };
    }
  }
  return null;
}

/**
 * Evaluate a simple condition expression.
 * Supports: truthy checks, equality (==, !=), comparison (>, <, >=, <=).
 */
function evaluateCondition(expression: string, context: WorkflowContext): boolean {
  const resolved = interpolateString(expression, context);

  const match = findOperator(resolved);
  if (match) {
    const { op, idx } = match;
    const left = resolved.slice(0, idx).trim();
    const right = resolved.slice(idx + op.length).trim();
    const leftNum = Number(left);
    const rightNum = Number(right);
    const useNum = !isNaN(leftNum) && !isNaN(rightNum);

    switch (op) {
      case '==': return useNum ? leftNum === rightNum : left === right;
      case '!=': return useNum ? leftNum !== rightNum : left !== right;
      case '>':  return useNum ? leftNum > rightNum : left > right;
      case '<':  return useNum ? leftNum < rightNum : left < right;
      case '>=': return useNum ? leftNum >= rightNum : left >= right;
      case '<=': return useNum ? leftNum <= rightNum : left <= right;
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
