/**
 * Graph Step Command — thin orchestrator for the `graph` connector.
 */
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';

const GRAPH_ACTIONS = ['read-inbox', 'download-attachments'] as const;
export type GraphAction = (typeof GRAPH_ACTIONS)[number];

export interface GraphStepConfig extends StepConfig {
  readonly action: GraphAction;
  readonly limit?: number;
  readonly sinceDate?: string | null;
  readonly sinceDays?: number | null;
  readonly id?: string;
  readonly downloadDir?: string;
  readonly accessToken?: string;
  readonly timeout?: number;
}

export const graphCommand: StepCommand<GraphStepConfig> = {
  type: 'graph',
  description: 'Microsoft Graph Mail operations (read-inbox, download-attachments).',
  defaultMofloLevel: 'memory',
  capabilities: [{ type: 'net' }, { type: 'fs:write' }],

  configSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...GRAPH_ACTIONS] },
      limit: { type: 'number' },
      sinceDate: { type: 'string' },
      sinceDays: { type: 'number' },
      id: { type: 'string' },
      downloadDir: { type: 'string' },
      accessToken: { type: 'string' },
      timeout: { type: 'number' },
    },
    required: ['action'],
  } satisfies JSONSchema,

  validate(config: GraphStepConfig): ValidationResult {
    const errors = [];
    if (!config.action || !GRAPH_ACTIONS.includes(config.action as GraphAction)) {
      errors.push({ path: 'action', message: `action must be one of: ${GRAPH_ACTIONS.join(', ')}` });
    }
    if (config.action === 'download-attachments' && !config.id) {
      errors.push({ path: 'id', message: 'id is required for download-attachments' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: GraphStepConfig, context: CastingContext): Promise<StepOutput> {
    const params = {
      limit: config.limit,
      sinceDate: config.sinceDate,
      sinceDays: config.sinceDays,
      id: config.id,
      downloadDir: config.downloadDir,
      accessToken: config.accessToken,
      timeout: config.timeout,
    };
    if (context.tools?.has('graph')) {
      return context.tools.execute('graph', config.action, params);
    }
    const { createGraphConnector } = await import('../connectors/graph.js');
    const connector = createGraphConnector();
    await connector.initialize({ accessToken: config.accessToken });
    try {
      return await connector.execute(config.action, params);
    } finally {
      await connector.dispose();
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'totalEmails', type: 'number' },
      { name: 'emails', type: 'array' },
      { name: 'emailsWithAttachments', type: 'number' },
      { name: 'newestTimestamp', type: 'string' },
      { name: 'sinceDate', type: 'string' },
      { name: 'totalBeforeFilter', type: 'number' },
      { name: 'downloaded', type: 'array' },
      { name: 'count', type: 'number' },
    ];
  },
};
