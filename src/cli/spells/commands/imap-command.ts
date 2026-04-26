/**
 * IMAP Step Command — thin orchestrator for the imap connector.
 *
 * Delegates to the registered `imap` connector when available; otherwise
 * creates a dedicated connector instance so spells using IMAP work even
 * without a connector registry.
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
  Prerequisite,
} from '../types/step-command.types.js';

// ============================================================================
// Config
// ============================================================================

const IMAP_ACTIONS = ['read-inbox', 'download-attachments'] as const;

export type ImapAction = (typeof IMAP_ACTIONS)[number];

export interface ImapStepConfig extends StepConfig {
  readonly action: ImapAction;
  readonly limit?: number;
  readonly sinceDate?: string | null;
  readonly sinceDays?: number | null;
  readonly uid?: number;
  readonly uids?: number[];
  readonly downloadDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly timeout?: number;
}

// ============================================================================
// Prerequisites
// ============================================================================

const imapPrerequisites: readonly Prerequisite[] = [
  {
    name: 'imapflow',
    check: async () => {
      try {
        const mod = 'imapflow';
        await import(/* @vite-ignore */ mod);
        return true;
      } catch {
        return false;
      }
    },
    installHint: 'Install imapflow and mailparser: npm install imapflow mailparser',
    url: 'https://imapflow.com/',
  },
];

// ============================================================================
// Step Command
// ============================================================================

export const imapCommand: StepCommand<ImapStepConfig> = {
  type: 'imap',
  description:
    'IMAP email operations — read INBOX metadata and download attachments via IMAPS. ' +
    'Credentials resolve from IMAP_USER / IMAP_PASSWORD / IMAP_HOST / IMAP_PORT env.',
  defaultMofloLevel: 'memory',
  prerequisites: imapPrerequisites,

  configSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...IMAP_ACTIONS],
        description: 'IMAP action: read-inbox, download-attachments',
      },
      limit: { type: 'number', description: 'Max messages (read-inbox). Default: 10', default: 10 },
      sinceDate: { type: 'string', description: 'ISO datetime — read-inbox only returns emails at/after this moment' },
      sinceDays: { type: 'number', description: 'Fallback when sinceDate is empty — filter to last N days' },
      uid: { type: 'number', description: 'Single message UID (download-attachments)' },
      uids: { type: 'array', items: { type: 'number' }, description: 'Multiple message UIDs (download-attachments)' },
      downloadDir: { type: 'string', description: 'Attachment download directory', default: '~/Downloads/attachments' },
      host: { type: 'string', description: 'IMAP host (default outlook.office365.com)' },
      port: { type: 'number', description: 'IMAP port (default 993)' },
      user: { type: 'string', description: 'IMAP user (overrides IMAP_USER env)' },
      password: { type: 'string', description: 'IMAP password (overrides IMAP_PASSWORD env)' },
      timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
    },
    required: ['action'],
  } satisfies JSONSchema,

  capabilities: [
    { type: 'net' },
    { type: 'fs:write' },
  ],

  validate(config: ImapStepConfig): ValidationResult {
    const errors: ValidationError[] = [];

    if (!config.action || !IMAP_ACTIONS.includes(config.action as ImapAction)) {
      errors.push({
        path: 'action',
        message: `action must be one of: ${IMAP_ACTIONS.join(', ')}`,
      });
    }

    if (config.action === 'download-attachments') {
      const hasUid = typeof config.uid === 'number';
      const hasUids = Array.isArray(config.uids) && config.uids.length > 0;
      if (!hasUid && !hasUids) {
        errors.push({
          path: 'uid',
          message: 'uid or uids is required for download-attachments',
        });
      }
    }

    return { valid: errors.length === 0, errors };
  },

  async execute(config: ImapStepConfig, context: CastingContext): Promise<StepOutput> {
    const params = {
      limit: config.limit,
      sinceDate: config.sinceDate,
      sinceDays: config.sinceDays,
      uid: config.uid,
      uids: config.uids,
      downloadDir: config.downloadDir,
    };

    if (context.tools?.has('imap')) {
      return context.tools.execute('imap', config.action, params);
    }

    const { createImapConnector } = await import('../connectors/imap.js');
    const connector = createImapConnector();
    await connector.initialize({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
    });

    try {
      return await connector.execute(config.action, params);
    } finally {
      await connector.dispose();
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'totalEmails', type: 'number', description: 'Number of emails returned after sinceDate filter' },
      { name: 'emails', type: 'array', description: 'Array of email objects (uid, subject, from, timestampIso, hasAttachment, sizeBytes)' },
      { name: 'emailsWithAttachments', type: 'number', description: 'Count of emails with attachments' },
      { name: 'newestTimestamp', type: 'string', description: 'ISO timestamp of newest email seen — persist for next run' },
      { name: 'sinceDate', type: 'string', description: 'Effective sinceDate used for the filter' },
      { name: 'totalBeforeFilter', type: 'number', description: 'Raw email count before sinceDate filter' },
      { name: 'downloaded', type: 'array', description: 'Paths of downloaded attachments' },
      { name: 'count', type: 'number', description: 'Number of attachments downloaded' },
    ];
  },
};
