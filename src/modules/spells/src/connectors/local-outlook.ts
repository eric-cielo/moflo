/**
 * Local Outlook Connector — Outlook.com automation via Playwright.
 *
 * This connector encapsulates all knowledge of how to interact with
 * Outlook.com's web UI: DOM selectors, navigation patterns, attachment
 * handling, and compose flows. It uses the Playwright connector's
 * persistent context support so the user signs in once and sessions
 * persist across runs.
 *
 * No API keys, OAuth tokens, or Azure subscriptions required.
 *
 * Architecture: This is the "knows how to talk to Outlook" layer.
 * Step commands (outlook-command.ts) compose this connector to build
 * higher-level actions.
 */

import type {
  SpellConnector,
  ConnectorAction,
  ConnectorOutput,
} from '../types/spell-connector.types.js';
import {
  loadPlaywright,
  type PlaywrightPage,
  type PlaywrightPersistentContext,
} from './playwright.js';

// ============================================================================
// Constants
// ============================================================================

const OUTLOOK_INBOX_URL = 'https://outlook.live.com/mail/0/inbox';
const DEFAULT_PROFILE = '~/.moflo/browser-profiles/outlook';
const DEFAULT_TIMEOUT = 30_000;

function resolveHome(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return p.replace('~', home);
  }
  return p;
}

// ============================================================================
// Outlook DOM Selectors
//
// Centralized here so DOM changes only need updating in one place.
// ============================================================================

const SEL = {
  inboxList: '[role="list"]',
  emailItems: '[role="listitem"], [data-convid]',
  subject: '[data-testid="subjectLine"], .hcptT, [title]',
  sender: '[data-testid="senderName"], .OZZZK, .lDdSm',
  preview: '[data-testid="bodyPreview"], .n5mNh',
  attachmentIcon: '[data-icon-name="Attach"], .attachment-icon, [aria-label*="attachment" i]',
  timestamp: '[data-testid="sentDate"], time, .l8Tnu',
  readingSubject: '[role="heading"], .allowTextSelection',
  readingBody: '[role="document"], .rps_ad0e, [aria-label="Message body"]',
  attachmentCards: '.attachment, [data-testid="attachmentCard"], .jGG6V',
  downloadBtn: '[data-icon-name="Download"], [aria-label*="download" i], .ms-Button',
  newMail: 'button[aria-label*="New mail" i], button[aria-label*="New message" i], [data-testid="newMessageButton"]',
  toField: '[aria-label="To"] input, [role="combobox"][aria-label*="To" i], input[aria-label*="To" i]',
  subjectField: 'input[aria-label*="Subject" i], input[placeholder*="subject" i]',
  bodyField: '[role="textbox"][aria-label*="Message body" i], [contenteditable="true"]',
  sendBtn: 'button[aria-label="Send" i], [data-testid="sendButton"]',
  searchBox: 'input[aria-label*="Search" i], [role="search"] input',
} as const;

// ============================================================================
// Evaluate scripts (run inside browser context as strings to avoid DOM types)
// ============================================================================

function makeInboxScript(max: number): string {
  return `(() => {
    const items = document.querySelectorAll('${SEL.emailItems}');
    return Array.from(items).slice(0, ${max}).map((item, i) => ({
      index: i,
      subject: (item.querySelector('${SEL.subject}') || {}).textContent?.trim() || '(no subject)',
      from: (item.querySelector('${SEL.sender}') || {}).textContent?.trim() || '(unknown)',
      preview: (item.querySelector('${SEL.preview}') || {}).textContent?.trim()?.slice(0, 150) || '',
      hasAttachment: !!item.querySelector('${SEL.attachmentIcon}'),
      timestamp: (item.querySelector('${SEL.timestamp}') || {}).textContent?.trim()
        || (item.querySelector('${SEL.timestamp}') || {}).getAttribute?.('datetime') || '',
    }));
  })()`;
}

function makeReadEmailScript(): string {
  return `(() => {
    const attachEls = document.querySelectorAll('${SEL.attachmentCards}');
    const attachments = Array.from(attachEls).map(el => el.textContent?.trim() || '');
    return {
      subject: (document.querySelector('${SEL.readingSubject}') || {}).textContent?.trim() || '',
      from: (document.querySelector('${SEL.sender}') || {}).textContent?.trim() || '',
      date: (document.querySelector('${SEL.timestamp}') || {}).textContent?.trim()
        || (document.querySelector('${SEL.timestamp}') || {}).getAttribute?.('datetime') || '',
      body: (document.querySelector('${SEL.readingBody}') || {}).textContent?.trim()?.slice(0, 2000) || '',
      attachments,
      hasAttachments: attachments.length > 0,
    };
  })()`;
}

// ============================================================================
// Action implementations
// ============================================================================

async function readInbox(page: PlaywrightPage, params: { limit?: number; timeout?: number }): Promise<ConnectorOutput> {
  const start = Date.now();
  const limit = params.limit ?? 10;
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  await page.goto(OUTLOOK_INBOX_URL, { timeout });
  await page.waitForSelector(SEL.inboxList, { timeout });

  const emails = await page.evaluate(makeInboxScript(limit)) as Array<{
    index: number; subject: string; from: string; preview: string; hasAttachment: boolean; timestamp: string;
  }>;

  return {
    success: true,
    data: {
      totalEmails: emails.length,
      emails,
      emailsWithAttachments: emails.filter(e => e.hasAttachment).length,
    },
    duration: Date.now() - start,
  };
}

async function readEmail(page: PlaywrightPage, params: { emailIndex: number; timeout?: number }): Promise<ConnectorOutput> {
  const start = Date.now();
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  const items = await page.$$(SEL.emailItems);
  if (params.emailIndex >= items.length) {
    return { success: false, data: {}, error: `Email index ${params.emailIndex} out of range (${items.length} available)`, duration: Date.now() - start };
  }

  await items[params.emailIndex].click();
  await page.waitForSelector(SEL.readingBody, { timeout }).catch(() => {
    console.warn('[local-outlook] Reading pane did not load within timeout — DOM selectors may need updating');
  });

  const emailData = await page.evaluate(makeReadEmailScript()) as {
    subject: string; from: string; date: string; body: string; attachments: string[]; hasAttachments: boolean;
  };

  return { success: true, data: emailData, duration: Date.now() - start };
}

async function downloadAttachments(page: PlaywrightPage, params: { emailIndex: number; downloadDir?: string; timeout?: number }): Promise<ConnectorOutput> {
  const start = Date.now();
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  const items = await page.$$(SEL.emailItems);
  if (params.emailIndex >= items.length) {
    return { success: false, data: {}, error: `Email index ${params.emailIndex} out of range`, duration: Date.now() - start };
  }

  await items[params.emailIndex].click();
  await page.waitForSelector(SEL.readingBody, { timeout }).catch(() => {
    console.warn('[local-outlook] Reading pane did not load within timeout — DOM selectors may need updating');
  });

  const attachmentEls = await page.$$(SEL.attachmentCards);
  const downloaded: string[] = [];
  const downloadDir = resolveHome(params.downloadDir || '~/Downloads/attachments');

  for (const attachEl of attachmentEls) {
    const name = await attachEl.evaluate((el: unknown) => (el as { textContent?: string }).textContent?.trim() || 'attachment');
    const dlBtn = await attachEl.$(SEL.downloadBtn);
    if (dlBtn) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout }),
        dlBtn.click(),
      ]);
      const filePath = `${downloadDir}/${download.suggestedFilename() || name}`;
      await download.saveAs(filePath);
      downloaded.push(filePath);
    }
  }

  return { success: true, data: { downloaded, count: downloaded.length }, duration: Date.now() - start };
}

async function sendEmail(page: PlaywrightPage, params: { to: string; subject: string; body: string; timeout?: number }): Promise<ConnectorOutput> {
  const start = Date.now();
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  await page.goto(OUTLOOK_INBOX_URL, { timeout });

  const newMailBtn = await page.waitForSelector(SEL.newMail, { timeout });
  await newMailBtn!.click();
  await page.waitForTimeout(1000);

  const toField = await page.waitForSelector(SEL.toField, { timeout });
  await toField!.fill(params.to);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);

  const subjectField = await page.waitForSelector(SEL.subjectField, { timeout });
  await subjectField!.fill(params.subject);

  const bodyField = await page.waitForSelector(SEL.bodyField, { timeout });
  await bodyField!.click();
  await page.type(SEL.bodyField, params.body);

  const sendBtn = await page.waitForSelector(SEL.sendBtn, { timeout });
  await sendBtn!.click();
  await page.waitForTimeout(1000);

  return { success: true, data: { to: params.to, subject: params.subject, sent: true }, duration: Date.now() - start };
}

async function searchEmails(page: PlaywrightPage, params: { query: string; limit?: number; timeout?: number }): Promise<ConnectorOutput> {
  const start = Date.now();
  const limit = params.limit ?? 10;
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  await page.goto(OUTLOOK_INBOX_URL, { timeout });

  const searchBox = await page.waitForSelector(SEL.searchBox, { timeout });
  await searchBox!.click();
  await searchBox!.fill(params.query);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  const emails = await page.evaluate(makeInboxScript(limit)) as Array<{
    index: number; subject: string; from: string; preview: string; hasAttachment: boolean;
  }>;

  return { success: true, data: { query: params.query, totalResults: emails.length, emails }, duration: Date.now() - start };
}

// ============================================================================
// Action descriptors
// ============================================================================

const ACTIONS: ConnectorAction[] = [
  {
    name: 'read-inbox',
    description: 'Fetch recent emails from Outlook.com inbox',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, timeout: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { totalEmails: { type: 'number' }, emails: { type: 'array' }, emailsWithAttachments: { type: 'number' } } },
  },
  {
    name: 'read-email',
    description: 'Read a specific email by index',
    inputSchema: { type: 'object', properties: { emailIndex: { type: 'number' } }, required: ['emailIndex'] },
    outputSchema: { type: 'object', properties: { subject: { type: 'string' }, from: { type: 'string' }, body: { type: 'string' }, attachments: { type: 'array' } } },
  },
  {
    name: 'download-attachments',
    description: 'Download attachments from an email to disk',
    inputSchema: { type: 'object', properties: { emailIndex: { type: 'number' }, downloadDir: { type: 'string' } }, required: ['emailIndex'] },
    outputSchema: { type: 'object', properties: { downloaded: { type: 'array' }, count: { type: 'number' } } },
  },
  {
    name: 'send-email',
    description: 'Compose and send an email via Outlook.com',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    outputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, sent: { type: 'boolean' } } },
  },
  {
    name: 'search',
    description: 'Search Outlook.com emails',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { query: { type: 'string' }, totalResults: { type: 'number' }, emails: { type: 'array' } } },
  },
];

// ============================================================================
// Connector factory — each call produces an independent instance
// ============================================================================

interface OutlookConnectorConfig {
  userDataDir: string;
  headless: boolean;
  downloadsPath?: string;
}

/**
 * Create an independent local-outlook connector instance.
 * Each instance owns its own browser context and config — safe for
 * concurrent spell runs.
 */
export function createLocalOutlookConnector(): SpellConnector {
  let config: OutlookConnectorConfig | null = null;
  let context: PlaywrightPersistentContext | null = null;

  async function ensureContext(): Promise<PlaywrightPage> {
    if (!context) {
      const cfg = config ?? {
        userDataDir: resolveHome(DEFAULT_PROFILE),
        headless: true,
      };
      const playwright = await loadPlaywright();
      context = await playwright.chromium.launchPersistentContext(cfg.userDataDir, {
        headless: cfg.headless,
        acceptDownloads: true,
        downloadsPath: cfg.downloadsPath,
      });
    }
    return context.pages()[0] ?? await context.newPage();
  }

  return {
    name: 'local-outlook',
    description: 'Outlook.com email automation via Playwright persistent browser. No API keys required — uses web UI directly.',
    version: '1.0.0',
    capabilities: ['read', 'write', 'search'],

    async initialize(cfg: Record<string, unknown>): Promise<void> {
      config = {
        userDataDir: resolveHome((cfg.userDataDir as string) || DEFAULT_PROFILE),
        headless: cfg.headless !== false,
        downloadsPath: cfg.downloadsPath
          ? resolveHome(cfg.downloadsPath as string)
          : undefined,
      };
    },

    async dispose(): Promise<void> {
      if (context) {
        try { await context.close(); } catch { /* ignore cleanup errors */ }
        context = null;
      }
      config = null;
    },

    async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
      try {
        const page = await ensureContext();

        switch (action) {
          case 'read-inbox':
            return await readInbox(page, params as { limit?: number; timeout?: number });
          case 'read-email':
            return await readEmail(page, params as { emailIndex: number; timeout?: number });
          case 'download-attachments':
            return await downloadAttachments(page, params as { emailIndex: number; downloadDir?: string; timeout?: number });
          case 'send-email':
            return await sendEmail(page, params as { to: string; subject: string; body: string; timeout?: number });
          case 'search':
            return await searchEmails(page, params as { query: string; limit?: number; timeout?: number });
          default:
            return { success: false, data: {}, error: `Unknown action: ${action}` };
        }
      } catch (err) {
        return { success: false, data: {}, error: `local-outlook: ${(err as Error).message}` };
      }
    },

    listActions(): ConnectorAction[] {
      return ACTIONS;
    },
  };
}

/** Default instance for built-in connector registration. */
export const localOutlookConnector: SpellConnector = createLocalOutlookConnector();
