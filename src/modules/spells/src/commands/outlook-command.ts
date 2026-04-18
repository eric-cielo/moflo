/**
 * Outlook Step Command — thin orchestrator for the local-outlook connector.
 *
 * This step command provides the `outlook` type for spell YAML. It validates
 * config, delegates execution to the `local-outlook` connector, and maps
 * connector outputs to step outputs.
 *
 * Architecture:
 * - Connector (local-outlook.ts): knows HOW to talk to Outlook.com via Playwright
 * - Step command (this file): knows WHAT to do — validates, delegates, outputs
 *
 * This separation means:
 * - Agent steps can also use the connector directly via context.tools
 * - The connector can be swapped (e.g., Graph API) without changing spell YAML
 * - DOM knowledge lives in one place (the connector), not spread across steps
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  Prerequisite,
} from '../types/step-command.types.js';

// ============================================================================
// Config
// ============================================================================

const OUTLOOK_ACTIONS = [
  'read-inbox',
  'read-email',
  'download-attachments',
  'send-email',
  'search',
] as const;

export type OutlookAction = (typeof OUTLOOK_ACTIONS)[number];

export interface OutlookStepConfig extends StepConfig {
  readonly action: OutlookAction;
  readonly limit?: number;
  readonly sinceDate?: string | null;
  readonly sinceDays?: number | null;
  readonly emailIndex?: number;
  readonly downloadDir?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly query?: string;
  readonly userDataDir?: string;
  readonly headless?: boolean;
  readonly timeout?: number;
}

// ============================================================================
// Prerequisites
// ============================================================================

const outlookPrerequisites: readonly Prerequisite[] = [
  {
    name: 'playwright',
    check: async () => {
      try {
        const mod = 'playwright';
        await import(/* @vite-ignore */ mod);
        return true;
      } catch {
        return false;
      }
    },
    installHint: 'Install Playwright: npm install playwright && npx playwright install chromium',
    url: 'https://playwright.dev/docs/intro',
  },
];

// ============================================================================
// Step Command
// ============================================================================

export const outlookCommand: StepCommand<OutlookStepConfig> = {
  type: 'outlook',
  description: 'Outlook.com email automation via local-outlook connector — read inbox, download attachments, send email, search. No API keys required.',
  defaultMofloLevel: 'memory',
  prerequisites: outlookPrerequisites,

  configSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...OUTLOOK_ACTIONS],
        description: 'Outlook action: read-inbox, read-email, download-attachments, send-email, search',
      },
      limit: { type: 'number', description: 'Max emails (read-inbox, search). Default: 10', default: 10 },
      sinceDate: { type: 'string', description: 'ISO datetime — read-inbox only returns emails at/after this moment' },
      sinceDays: { type: 'number', description: 'Fallback when sinceDate is empty — filter to last N days' },
      emailIndex: { type: 'number', description: 'Email index (0-based) for read-email, download-attachments' },
      downloadDir: { type: 'string', description: 'Attachment download directory', default: '~/Downloads/attachments' },
      to: { type: 'string', description: 'Recipient email (send-email)' },
      subject: { type: 'string', description: 'Email subject (send-email)' },
      body: { type: 'string', description: 'Email body (send-email)' },
      query: { type: 'string', description: 'Search query (search)' },
      userDataDir: { type: 'string', description: 'Persistent browser profile path', default: '~/.moflo/browser-profiles/outlook' },
      headless: { type: 'boolean', description: 'Run headless (default: true)', default: true },
      timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
    },
    required: ['action'],
  } satisfies JSONSchema,

  capabilities: [
    { type: 'browser' },
    { type: 'browser:evaluate' },
    { type: 'net' },
    { type: 'fs:write' },
  ],

  validate(config: OutlookStepConfig): ValidationResult {
    const errors = [];

    if (!config.action || !OUTLOOK_ACTIONS.includes(config.action as OutlookAction)) {
      errors.push({
        path: 'action',
        message: `action must be one of: ${OUTLOOK_ACTIONS.join(', ')}`,
      });
    }

    if (config.action === 'send-email') {
      if (!config.to) errors.push({ path: 'to', message: 'to is required for send-email' });
      if (!config.subject) errors.push({ path: 'subject', message: 'subject is required for send-email' });
      if (!config.body) errors.push({ path: 'body', message: 'body is required for send-email' });
    }

    if (config.action === 'search' && !config.query) {
      errors.push({ path: 'query', message: 'query is required for search' });
    }

    if ((config.action === 'read-email' || config.action === 'download-attachments') && config.emailIndex === undefined) {
      errors.push({ path: 'emailIndex', message: 'emailIndex is required for read-email and download-attachments' });
    }

    return { valid: errors.length === 0, errors };
  },

  async execute(config: OutlookStepConfig, context: CastingContext): Promise<StepOutput> {
    // Prefer the connector registry if available (proper DI path)
    if (context.tools?.has('local-outlook')) {
      return context.tools.execute('local-outlook', config.action, {
        limit: config.limit,
        sinceDate: config.sinceDate,
        sinceDays: config.sinceDays,
        emailIndex: config.emailIndex,
        downloadDir: config.downloadDir,
        to: config.to,
        subject: config.subject,
        body: config.body,
        query: config.query,
        timeout: config.timeout,
      });
    }

    // Fallback: create a dedicated connector instance for this execution
    const { createLocalOutlookConnector } = await import('../connectors/local-outlook.js');
    const connector = createLocalOutlookConnector();
    await connector.initialize({
      userDataDir: config.userDataDir,
      headless: config.headless,
      downloadsPath: config.downloadDir,
    });

    try {
      return await connector.execute(config.action, {
        limit: config.limit,
        sinceDate: config.sinceDate,
        sinceDays: config.sinceDays,
        emailIndex: config.emailIndex,
        downloadDir: config.downloadDir,
        to: config.to,
        subject: config.subject,
        body: config.body,
        query: config.query,
        timeout: config.timeout,
      });
    } finally {
      await connector.dispose();
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'totalEmails', type: 'number', description: 'Number of emails returned after sinceDate filter' },
      { name: 'emails', type: 'array', description: 'Array of email objects' },
      { name: 'emailsWithAttachments', type: 'number', description: 'Count of emails with attachments' },
      { name: 'newestTimestamp', type: 'string', description: 'ISO timestamp of newest email seen — persist for next run' },
      { name: 'totalBeforeFilter', type: 'number', description: 'Raw email count before sinceDate filter' },
      { name: 'downloaded', type: 'array', description: 'Paths of downloaded attachments' },
      { name: 'count', type: 'number', description: 'Number of attachments downloaded' },
      { name: 'sent', type: 'boolean', description: 'Whether email was sent (send-email)' },
      { name: 'query', type: 'string', description: 'Search query used (search)' },
      { name: 'totalResults', type: 'number', description: 'Search result count' },
    ];
  },
};
