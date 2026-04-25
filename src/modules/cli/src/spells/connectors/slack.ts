/**
 * Slack Connector — post messages via Incoming Webhooks or Web API.
 *
 * Two actions:
 *   - post-webhook: simple JSON POST to a Slack Incoming Webhook URL.
 *     No token required; the webhook itself is the credential. Suitable for
 *     workspace notifications and "message to self" when the webhook is
 *     wired to a DM channel.
 *   - post-message: chat.postMessage via the Slack Web API. Requires a bot
 *     or user token. Needed when the target channel (or user DM) isn't
 *     knowable at webhook-creation time.
 *
 * Credentials resolve from connector config first, then env vars
 * (`SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN`). Neither ever appears in YAML.
 */
import type {
  SpellConnector,
  ConnectorAction,
  ConnectorOutput,
} from '../types/spell-connector.types.js';

// ============================================================================
// Types
// ============================================================================

interface WebhookParams {
  webhookUrl?: string;
  text: string;
  blocks?: unknown[];
  attachments?: unknown[];
  username?: string;
  iconEmoji?: string;
  timeout?: number;
}

interface PostMessageParams {
  token?: string;
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  unfurlLinks?: boolean;
  timeout?: number;
}

// ============================================================================
// Actions
// ============================================================================

const ACTIONS: ConnectorAction[] = [
  {
    name: 'post-webhook',
    description: 'POST a message to a Slack Incoming Webhook URL',
    inputSchema: {
      type: 'object',
      properties: {
        webhookUrl: { type: 'string', description: 'Webhook URL (overrides SLACK_WEBHOOK_URL env)' },
        text: { type: 'string', description: 'Fallback text (also shown in notifications)' },
        blocks: { type: 'array', description: 'Block Kit blocks (optional)' },
        attachments: { type: 'array', description: 'Message attachments (optional)' },
        username: { type: 'string', description: 'Override username (if webhook allows)' },
        iconEmoji: { type: 'string', description: 'Override icon emoji, e.g. :robot_face:' },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['text'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        status: { type: 'number' },
      },
    },
  },
  {
    name: 'post-message',
    description: 'chat.postMessage via Slack Web API (requires SLACK_BOT_TOKEN)',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Bot/user token (overrides SLACK_BOT_TOKEN env)' },
        channel: { type: 'string', description: 'Channel ID, name (#general), or user ID for DM' },
        text: { type: 'string', description: 'Message text' },
        blocks: { type: 'array', description: 'Block Kit blocks (optional)' },
        threadTs: { type: 'string', description: 'Parent thread timestamp (reply in thread)' },
        unfurlLinks: { type: 'boolean' },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['channel', 'text'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        ts: { type: 'string' },
        channel: { type: 'string' },
      },
    },
  },
];

// ============================================================================
// Config
// ============================================================================

interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
}

// ============================================================================
// Factory
// ============================================================================

export function createSlackConnector(): SpellConnector {
  let config: SlackConfig = {};

  return {
    name: 'slack',
    description:
      'Slack messaging via Incoming Webhooks or Web API chat.postMessage. ' +
      'Credentials resolve from connector config or SLACK_WEBHOOK_URL / SLACK_BOT_TOKEN env.',
    version: '1.0.0',
    capabilities: ['write'],

    async initialize(cfg: Record<string, unknown>): Promise<void> {
      config = {
        webhookUrl: typeof cfg.webhookUrl === 'string' ? cfg.webhookUrl : undefined,
        botToken: typeof cfg.botToken === 'string' ? cfg.botToken : undefined,
      };
    },

    async dispose(): Promise<void> {
      config = {};
    },

    async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
      const start = Date.now();
      try {
        switch (action) {
          case 'post-webhook':
            return await postWebhook(params as unknown as WebhookParams, config, start);
          case 'post-message':
            return await postMessage(params as unknown as PostMessageParams, config, start);
          default:
            return {
              success: false,
              data: {},
              error: `Unknown action "${action}". Available: post-webhook, post-message`,
              duration: Date.now() - start,
            };
        }
      } catch (err) {
        return {
          success: false,
          data: {},
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - start,
        };
      }
    },

    listActions(): ConnectorAction[] {
      return ACTIONS;
    },
  };
}

export const slackConnector: SpellConnector = createSlackConnector();

// ============================================================================
// Action implementations
// ============================================================================

async function postWebhook(
  params: WebhookParams,
  config: SlackConfig,
  start: number,
): Promise<ConnectorOutput> {
  const url = params.webhookUrl || config.webhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    return {
      success: false,
      data: {},
      error: 'Missing Slack webhook URL. Set SLACK_WEBHOOK_URL env or pass webhookUrl.',
      duration: Date.now() - start,
    };
  }
  if (!params.text) {
    return {
      success: false,
      data: {},
      error: 'Missing required parameter: text',
      duration: Date.now() - start,
    };
  }

  const body: Record<string, unknown> = { text: params.text };
  if (params.blocks) body.blocks = params.blocks;
  if (params.attachments) body.attachments = params.attachments;
  if (params.username) body.username = params.username;
  if (params.iconEmoji) body.icon_emoji = params.iconEmoji;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: params.timeout ? AbortSignal.timeout(params.timeout) : undefined,
  });

  const responseText = await response.text();
  const ok = response.ok && responseText.trim() === 'ok';

  return {
    success: ok,
    data: { ok, status: response.status, response: responseText },
    error: ok ? undefined : `Slack webhook ${response.status}: ${responseText}`,
    duration: Date.now() - start,
  };
}

async function postMessage(
  params: PostMessageParams,
  config: SlackConfig,
  start: number,
): Promise<ConnectorOutput> {
  const token = params.token || config.botToken || process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return {
      success: false,
      data: {},
      error: 'Missing Slack token. Set SLACK_BOT_TOKEN env or pass token.',
      duration: Date.now() - start,
    };
  }
  if (!params.channel) {
    return { success: false, data: {}, error: 'Missing required parameter: channel', duration: Date.now() - start };
  }
  if (!params.text) {
    return { success: false, data: {}, error: 'Missing required parameter: text', duration: Date.now() - start };
  }

  const body: Record<string, unknown> = {
    channel: params.channel,
    text: params.text,
  };
  if (params.blocks) body.blocks = params.blocks;
  if (params.threadTs) body.thread_ts = params.threadTs;
  if (params.unfurlLinks !== undefined) body.unfurl_links = params.unfurlLinks;

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: params.timeout ? AbortSignal.timeout(params.timeout) : undefined,
  });

  // Slack Web API always returns 200 even for logical errors;
  // the `ok` field in the JSON body is the real signal.
  let payload: { ok?: boolean; error?: string; ts?: string; channel?: string } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    return {
      success: false,
      data: { status: response.status },
      error: `Slack API returned non-JSON response (status ${response.status})`,
      duration: Date.now() - start,
    };
  }

  const ok = Boolean(payload.ok);
  return {
    success: ok,
    data: { ok, ts: payload.ts, channel: payload.channel, status: response.status },
    error: ok ? undefined : `Slack API error: ${payload.error ?? 'unknown'}`,
    duration: Date.now() - start,
  };
}
