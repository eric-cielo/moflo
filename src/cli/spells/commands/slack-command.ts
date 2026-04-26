/**
 * Slack Step Command — thin orchestrator for the `slack` connector.
 *
 * Provides the `slack` step type for spell YAML. Actions:
 *   - post-webhook: Slack Incoming Webhook
 *   - post-message: Slack Web API chat.postMessage
 *
 * See connectors/slack.ts for the transport layer.
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

const SLACK_ACTIONS = ['post-webhook', 'post-message'] as const;
export type SlackAction = (typeof SLACK_ACTIONS)[number];

export interface SlackStepConfig extends StepConfig {
  readonly action: SlackAction;
  readonly webhookUrl?: string;
  readonly token?: string;
  readonly channel?: string;
  readonly text?: string;
  readonly blocks?: unknown[];
  readonly attachments?: unknown[];
  readonly username?: string;
  readonly iconEmoji?: string;
  readonly threadTs?: string;
  readonly unfurlLinks?: boolean;
  readonly timeout?: number;
}

export const slackCommand: StepCommand<SlackStepConfig> = {
  type: 'slack',
  description: 'Post messages to Slack via Incoming Webhook or Web API chat.postMessage.',
  defaultMofloLevel: 'memory',

  configSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...SLACK_ACTIONS],
        description: 'post-webhook or post-message',
      },
      webhookUrl: { type: 'string', description: 'Webhook URL (or SLACK_WEBHOOK_URL env)' },
      token: { type: 'string', description: 'Bot token (or SLACK_BOT_TOKEN env)' },
      channel: { type: 'string', description: 'Channel/user ID for post-message' },
      text: { type: 'string', description: 'Message text' },
      blocks: { type: 'array', description: 'Block Kit blocks' },
      attachments: { type: 'array', description: 'Webhook attachments' },
      username: { type: 'string' },
      iconEmoji: { type: 'string' },
      threadTs: { type: 'string' },
      unfurlLinks: { type: 'boolean' },
      timeout: { type: 'number', default: 30000 },
    },
    required: ['action', 'text'],
  } satisfies JSONSchema,

  capabilities: [{ type: 'net' }],

  validate(config: SlackStepConfig): ValidationResult {
    const errors: ValidationError[] = [];

    if (!config.action || !SLACK_ACTIONS.includes(config.action as SlackAction)) {
      errors.push({
        path: 'action',
        message: `action must be one of: ${SLACK_ACTIONS.join(', ')}`,
      });
    }
    if (!config.text) {
      errors.push({ path: 'text', message: 'text is required' });
    }
    if (config.action === 'post-message' && !config.channel) {
      errors.push({ path: 'channel', message: 'channel is required for post-message' });
    }

    return { valid: errors.length === 0, errors };
  },

  async execute(config: SlackStepConfig, context: CastingContext): Promise<StepOutput> {
    const params: Record<string, unknown> = {
      text: config.text,
      blocks: config.blocks,
      attachments: config.attachments,
      username: config.username,
      iconEmoji: config.iconEmoji,
      webhookUrl: config.webhookUrl,
      token: config.token,
      channel: config.channel,
      threadTs: config.threadTs,
      unfurlLinks: config.unfurlLinks,
      timeout: config.timeout,
    };

    if (context.tools?.has('slack')) {
      return context.tools.execute('slack', config.action, params);
    }

    // Fallback: instantiate connector directly (e.g. standalone test runs).
    const { createSlackConnector } = await import('../connectors/slack.js');
    const connector = createSlackConnector();
    await connector.initialize({
      webhookUrl: config.webhookUrl,
      botToken: config.token,
    });
    try {
      return await connector.execute(config.action, params);
    } finally {
      await connector.dispose();
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'ok', type: 'boolean', description: 'Whether Slack accepted the message' },
      { name: 'ts', type: 'string', description: 'Message timestamp (post-message)' },
      { name: 'channel', type: 'string', description: 'Resolved channel ID (post-message)' },
      { name: 'status', type: 'number', description: 'HTTP status code' },
    ];
  },
};
