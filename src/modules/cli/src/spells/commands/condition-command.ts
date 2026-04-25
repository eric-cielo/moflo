/**
 * Condition Step Command — branches on expression evaluation.
 *
 * Evaluates a simple expression string against context variables.
 * Returns which branch (then/else) should execute next.
 *
 * Supports two formats:
 * - String format: `{ if: "{step.value} == expected" }` (backward compat)
 * - Structured format: `{ left: "{step.value}", op: "==", right: "expected" }`
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationError,
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

// ── Typed config ─────────────────────────────────────────────────────────

/** String-based condition format (backward compatible). */
interface ConditionStringFormat {
  readonly if: string;
}

/** Structured condition format (Issue #190). */
interface ConditionStructuredFormat {
  readonly left: string;
  readonly op: Operator;
  readonly right: string;
}

/**
 * Typed config for the condition step command.
 * Accepts either a string expression (`if`) or structured operands (`left`, `op`, `right`).
 * Both formats can include `then` / `else` branch targets.
 */
export type ConditionStepConfig = StepConfig & (ConditionStringFormat | ConditionStructuredFormat) & {
  readonly then?: string;
  readonly else?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Check whether the config uses the structured format. */
function isStructured(config: ConditionStepConfig): config is StepConfig & ConditionStructuredFormat & { then?: string; else?: string } {
  return typeof (config as Record<string, unknown>).left === 'string'
    && typeof (config as Record<string, unknown>).op === 'string'
    && typeof (config as Record<string, unknown>).right === 'string';
}

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
 * Compare two resolved values using the given operator.
 * Numeric comparison is used when both sides parse as numbers.
 */
function compareValues(left: string, op: Operator, right: string): boolean {
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

/**
 * Evaluate a simple condition expression (string format).
 * Supports: truthy checks, equality (==, !=), comparison (>, <, >=, <=).
 */
function evaluateStringCondition(expression: string, context: CastingContext): boolean {
  const resolved = interpolateString(expression, context);

  const match = findOperator(resolved);
  if (match) {
    const { op, idx } = match;
    const left = resolved.slice(0, idx).trim();
    const right = resolved.slice(idx + op.length).trim();
    return compareValues(left, op, right);
  }

  // Truthy check
  return resolved !== '' && resolved !== '0' && resolved !== 'false' && resolved !== 'null' && resolved !== 'undefined';
}

/**
 * Evaluate a structured condition (Issue #190).
 * Interpolates left/right independently, then compares with the given operator.
 * This avoids the string-parsing ambiguity of `findOperator()`.
 */
function evaluateStructuredCondition(
  left: string,
  op: Operator,
  right: string,
  context: CastingContext,
): boolean {
  const resolvedLeft = interpolateString(left, context).trim();
  const resolvedRight = interpolateString(right, context).trim();
  return compareValues(resolvedLeft, op, resolvedRight);
}

// ── Command ──────────────────────────────────────────────────────────────

export const conditionCommand: StepCommand<ConditionStepConfig> = {
  type: 'condition',
  description: 'Branch spell based on expression evaluation',
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      if: { type: 'string', description: 'Expression to evaluate (string format)' },
      left: { type: 'string', description: 'Left operand (structured format)' },
      op: { type: 'string', enum: [...OPERATORS], description: 'Comparison operator (structured format)' },
      right: { type: 'string', description: 'Right operand (structured format)' },
      then: { type: 'string', description: 'Step ID to run if true' },
      else: { type: 'string', description: 'Step ID to run if false' },
    },
  } satisfies JSONSchema,

  validate(config: ConditionStepConfig): ValidationResult {
    const errors: ValidationError[] = [];
    const hasStringFormat = typeof (config as Record<string, unknown>).if === 'string';
    const hasStructuredFormat = isStructured(config);

    if (!hasStringFormat && !hasStructuredFormat) {
      errors.push({
        path: 'if',
        message: 'Either "if" (string expression) or "left" + "op" + "right" (structured) is required',
      });
    }

    if (hasStructuredFormat) {
      const op = (config as Record<string, unknown>).op as string;
      if (!OPERATORS.includes(op as Operator)) {
        errors.push({ path: 'op', message: `op must be one of: ${OPERATORS.join(', ')}` });
      }
    }

    return { valid: errors.length === 0, errors };
  },

  async execute(config: ConditionStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();

    // Prefer structured format when present (avoids string-parsing ambiguity)
    const result = isStructured(config)
      ? evaluateStructuredCondition(config.left, config.op, config.right, context)
      : evaluateStringCondition((config as ConditionStringFormat & StepConfig).if, context);

    const nextStep = result
      ? (config.then ?? null)
      : (config.else ?? null);

    return {
      success: true,
      data: {
        result,
        branch: result ? 'then' : 'else',
        nextStep,
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
