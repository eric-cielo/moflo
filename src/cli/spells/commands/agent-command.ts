/**
 * Agent Step Command — declared but NOT executable (#1334).
 *
 * This step type has never spawned anything. moflo has no agent spawner in the
 * spell runner, and nothing anywhere reads the invocation this command used to
 * "prepare" — it returned `success: true` with `result: "Agent task prepared"`
 * for work that never happened, so a spell containing an `agent` step completed
 * green and downstream steps consumed that string as though it were agent
 * output.
 *
 * It now fails loudly instead. The type stays **registered** on purpose: it is
 * public spell-authoring surface, and removing it would turn a silently-useless
 * step into a hard parse error for any consumer whose spell YAML contains one.
 * `validate()` and `configSchema` are therefore unchanged — existing spells
 * still parse and validate; they just no longer report success.
 *
 * The capability scope check runs *before* the failure so a scope violation
 * still surfaces as a scope violation (#258) rather than being masked by the
 * generic not-executable error.
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
 * Returned by every in-scope execution. Names the step type and the working
 * alternative, because a caller who hits this is mid-spell and needs the
 * substitution, not a diagnosis.
 *
 * Carries no issue number: this reaches consumer terminals, and `#NNNN`
 * resolves against the consumer's own repo, not moflo's.
 */
export const AGENT_STEP_NOT_EXECUTABLE =
  'The "agent" step type is not executable: moflo has no agent spawner, so no subagent is started. '
  + 'It previously reported success without running anything. '
  + 'To run a Claude subagent from a spell, use a "bash" step invoking `claude -p "<prompt>"`.';

/** Typed config for the agent step command. */
export interface AgentStepConfig extends StepConfig {
  readonly prompt: string;
  readonly agentType?: string;
  readonly background?: boolean;
}

export const agentCommand: StepCommand<AgentStepConfig> = {
  type: 'agent',
  description: 'NOT EXECUTABLE — declared so existing spells still parse; always fails',
  capabilities: [{ type: 'agent' }],
  defaultMofloLevel: 'memory',
  // No prerequisites. The `claude` CLI used to be required here, which gated
  // preflight on a binary this step cannot use — a consumer without `claude`
  // got "Install Claude CLI" instead of the real reason.
  configSchema: {
    type: 'object',
    properties: {
      agentType: { type: 'string', description: 'Agent type (e.g. researcher, coder, tester)' },
      prompt: { type: 'string', description: 'Task prompt for the agent' },
      background: { type: 'boolean', description: 'Run in background', default: false },
    },
    required: ['prompt'],
  } satisfies JSONSchema,

  validate(config: AgentStepConfig): ValidationResult {
    const errors: ValidationError[] = [];
    if (!config.prompt || typeof config.prompt !== 'string') {
      errors.push({ path: 'prompt', message: 'prompt is required and must be a string' });
    }
    if (config.agentType !== undefined && typeof config.agentType !== 'string') {
      errors.push({ path: 'agentType', message: 'agentType must be a string' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: AgentStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();

    // agentType is interpolated strictly — the scope check below must see the
    // resolved value, so an unresolvable one has to fail rather than be waved
    // through. The prompt is echoed for diagnosis only, so a bad reference in
    // it must not replace the not-executable message with an interpolation
    // error: spells with an `agent` step are exactly the ones holding stale
    // `{step.result}` references, since that output never existed.
    const agentType = config.agentType
      ? interpolateString(config.agentType, context)
      : 'general-purpose';
    let prompt: string;
    try {
      prompt = interpolateString(config.prompt, context);
    } catch {
      prompt = config.prompt;
    }

    // Enforce agent capability scope first (Issue #258 — gateway enforcement).
    // Ordering is load-bearing: a denied agent type must report the denial, not
    // the not-executable message, or scope violations become invisible.
    try {
      context.gateway.checkAgent(agentType);
    } catch (err) {
      return {
        success: false,
        data: { agentType, prompt },
        error: (err as Error).message,
        duration: Date.now() - start,
      };
    }

    return {
      success: false,
      data: { agentType, prompt },
      error: AGENT_STEP_NOT_EXECUTABLE,
      duration: Date.now() - start,
    };
  },

  // Only the fields the failure actually carries. `result` and `background`
  // were listed here but can never be produced, which is what let authors
  // reference `{step.result}` expecting agent output.
  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'agentType', type: 'string' },
      { name: 'prompt', type: 'string' },
    ];
  },
};
