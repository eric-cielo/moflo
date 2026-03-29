/**
 * Agent Step Command — spawns a Claude subagent.
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

/** Typed config for the agent step command. */
export interface AgentStepConfig extends StepConfig {
  readonly prompt: string;
  readonly agentType?: string;
  readonly background?: boolean;
}

export const agentCommand: StepCommand<AgentStepConfig> = {
  type: 'agent',
  description: 'Spawn a Claude subagent to perform a task',
  capabilities: [{ type: 'agent' }],
  defaultMofloLevel: 'memory',
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
    const errors = [];
    if (!config.prompt || typeof config.prompt !== 'string') {
      errors.push({ path: 'prompt', message: 'prompt is required and must be a string' });
    }
    if (config.agentType !== undefined && typeof config.agentType !== 'string') {
      errors.push({ path: 'agentType', message: 'agentType must be a string' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: AgentStepConfig, context: WorkflowContext): Promise<StepOutput> {
    const start = Date.now();
    const prompt = interpolateString(config.prompt, context);
    const agentType = config.agentType
      ? interpolateString(config.agentType, context)
      : 'general-purpose';

    // Agent execution is delegated to the workflow runner's agent spawner.
    // This command prepares the invocation; actual spawning is handled externally.
    return {
      success: true,
      data: {
        agentType,
        prompt,
        background: Boolean(config.background),
        result: `Agent task prepared: ${agentType}`,
      },
      duration: Date.now() - start,
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'agentType', type: 'string' },
      { name: 'prompt', type: 'string' },
      { name: 'background', type: 'boolean' },
      { name: 'result', type: 'string' },
    ];
  },
};
