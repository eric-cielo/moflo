/**
 * Memory Step Command — read/write/search shared workflow state via MemoryAccessor.
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
import { enforceScope, formatViolations } from '../core/capability-validator.js';

type MemoryAction = 'read' | 'write' | 'search';

const VALID_ACTIONS: readonly MemoryAction[] = ['read', 'write', 'search'];

/** Typed config for the memory step command. */
export interface MemoryStepConfig extends StepConfig {
  readonly action: MemoryAction;
  readonly namespace: string;
  readonly key?: string;
  readonly value?: unknown;
  readonly query?: string;
}

export const memoryCommand: StepCommand<MemoryStepConfig> = {
  type: 'memory',
  description: 'Read, write, or search shared workflow state',
  capabilities: [{ type: 'memory' }],
  defaultMofloLevel: 'memory',
  configSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'search'], description: 'Memory operation' },
      namespace: { type: 'string', description: 'Memory namespace' },
      key: { type: 'string', description: 'Key to read/write (required for read/write)' },
      value: { description: 'Value to write (required for write)' },
      query: { type: 'string', description: 'Search query (required for search)' },
    },
    required: ['action', 'namespace'],
  } satisfies JSONSchema,

  validate(config: MemoryStepConfig): ValidationResult {
    const errors = [];
    const action = config.action;

    if (!action || !VALID_ACTIONS.includes(action as MemoryAction)) {
      errors.push({ path: 'action', message: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
    }
    if (!config.namespace || typeof config.namespace !== 'string') {
      errors.push({ path: 'namespace', message: 'namespace is required' });
    }
    if ((action === 'read' || action === 'write') && (!config.key || typeof config.key !== 'string')) {
      errors.push({ path: 'key', message: 'key is required for read/write operations' });
    }
    if (action === 'write' && config.value === undefined) {
      errors.push({ path: 'value', message: 'value is required for write operations' });
    }
    if (action === 'search' && (!config.query || typeof config.query !== 'string')) {
      errors.push({ path: 'query', message: 'query is required for search operations' });
    }

    return { valid: errors.length === 0, errors };
  },

  async execute(config: MemoryStepConfig, context: WorkflowContext): Promise<StepOutput> {
    const start = Date.now();
    const action = config.action;
    const namespace = interpolateString(config.namespace, context);

    // Enforce memory capability scope on namespace (Issue #178, #258 — gateway migration)
    if (context.gateway) {
      try {
        context.gateway.checkMemory(namespace);
      } catch (err) {
        return {
          success: false,
          data: {},
          error: (err as Error).message,
          duration: Date.now() - start,
        };
      }
    } else if (context.effectiveCaps) {
      const violation = enforceScope(context.effectiveCaps, 'memory', namespace, context.taskId, 'memory');
      if (violation) {
        return {
          success: false,
          data: {},
          error: formatViolations([violation]),
          duration: Date.now() - start,
        };
      }
    }

    switch (action) {
      case 'read': {
        const key = interpolateString(config.key!, context);
        const value = await context.memory.read(namespace, key);
        return {
          success: true,
          data: { value, found: value !== null },
          duration: Date.now() - start,
        };
      }
      case 'write': {
        const key = interpolateString(config.key!, context);
        const value = typeof config.value === 'string'
          ? interpolateString(config.value, context)
          : config.value;
        await context.memory.write(namespace, key, value);
        return {
          success: true,
          data: { written: true, key },
          duration: Date.now() - start,
        };
      }
      case 'search': {
        const query = interpolateString(config.query!, context);
        const results = await context.memory.search(namespace, query);
        return {
          success: true,
          data: { results, count: results.length },
          duration: Date.now() - start,
        };
      }
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'value', type: 'object', description: 'Read result' },
      { name: 'found', type: 'boolean', description: 'Whether key was found (read)' },
      { name: 'written', type: 'boolean', description: 'Write success' },
      { name: 'results', type: 'array', description: 'Search results' },
      { name: 'count', type: 'number', description: 'Search result count' },
    ];
  },
};
