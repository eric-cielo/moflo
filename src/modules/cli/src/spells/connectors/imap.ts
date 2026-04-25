/**
 * IMAP Connector — read Outlook.com (and any IMAPS server) via the IMAP protocol.
 *
 * Exists because Microsoft blocks automated browsers before sign-in on
 * outlook.live.com, which breaks the browser-automation path in
 * local-outlook.ts for fresh profiles. IMAPS on outlook.office365.com
 * bypasses that gate entirely — given a user + app password, the
 * protocol just works.
 *
 * Actions:
 *   - read-inbox: list message metadata from INBOX (uid, subject, from,
 *     timestamps, attachment flag, size). Supports sinceDate / sinceDays
 *     filtering via the same helpers the local-outlook connector uses,
 *     so the output shape is identical and spells can swap backends.
 *   - download-attachments: given a uid (or uids), fetch each full
 *     message source, parse the MIME tree with mailparser, and write
 *     every attachment to downloadDir.
 *
 * Credentials: connector config > env (IMAP_USER, IMAP_PASSWORD,
 * IMAP_HOST, IMAP_PORT). Never appear in YAML.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  SpellConnector,
  ConnectorAction,
  ConnectorOutput,
} from '../types/spell-connector.types.js';
import {
  resolveSinceDate,
  filterEmailsSince,
  type InboxEmail,
} from './local-outlook.js';
import { loadOptional } from './shared/optional-import.js';

const IMAP_INSTALL_MSG =
  "IMAP connector requires 'imapflow' and 'mailparser' to be installed. Run: npm i imapflow mailparser";

// ============================================================================
// Types (structurally compatible with imapflow — avoids a hard type import
// so tests can mock the module without pulling full type machinery)
// ============================================================================

interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  fetchAll(range: unknown, query: Record<string, boolean>): Promise<FetchedMessage[]>;
}

interface FetchedMessage {
  uid: number;
  seq: number;
  size?: number;
  internalDate?: Date | string;
  envelope?: {
    date?: Date;
    subject?: string;
    from?: Array<{ name?: string; address?: string }>;
  };
  bodyStructure?: BodyPart;
  source?: Buffer;
}

interface BodyPart {
  type?: string;
  disposition?: string;
  childNodes?: BodyPart[];
}

type ImapFlowCtor = new (opts: Record<string, unknown>) => ImapFlowLike;

// ============================================================================
// Config
// ============================================================================

interface ImapConfig {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
}

const DEFAULT_HOST = 'outlook.office365.com';
const DEFAULT_PORT = 993;
const DEFAULT_DOWNLOAD_DIR = '~/Downloads/attachments';

function resolveHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return p.replace('~', home);
  }
  return p;
}

function resolveCreds(config: ImapConfig): {
  user?: string;
  password?: string;
  host: string;
  port: number;
} {
  return {
    user: config.user ?? process.env.IMAP_USER,
    password: config.password ?? process.env.IMAP_PASSWORD,
    host: config.host ?? process.env.IMAP_HOST ?? DEFAULT_HOST,
    port: config.port ?? (Number(process.env.IMAP_PORT) || DEFAULT_PORT),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function hasAttachment(part: BodyPart | undefined): boolean {
  if (!part) return false;
  if (part.disposition && part.disposition.toLowerCase() === 'attachment') return true;
  if (part.childNodes) {
    for (const c of part.childNodes) if (hasAttachment(c)) return true;
  }
  return false;
}

function formatFrom(env: FetchedMessage['envelope']): string {
  const a = env?.from?.[0];
  if (!a) return '(unknown)';
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || '(unknown)';
}

function toIso(d: Date | string | undefined): string {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString();
  const parsed = new Date(d);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

type SimpleParser = (src: Buffer) => Promise<{
  attachments?: Array<{ filename?: string; content?: Buffer; contentType?: string }>;
}>;

async function loadImapFlow(): Promise<ImapFlowCtor> {
  const mod = await loadOptional<{ ImapFlow: ImapFlowCtor }>('imapflow', IMAP_INSTALL_MSG);
  return mod.ImapFlow;
}

async function loadSimpleParser(): Promise<SimpleParser> {
  const mod = await loadOptional<{ simpleParser: SimpleParser }>('mailparser', IMAP_INSTALL_MSG);
  return mod.simpleParser;
}

async function withClient<T>(
  creds: ReturnType<typeof resolveCreds>,
  fn: (client: ImapFlowLike) => Promise<T>,
): Promise<T> {
  const ImapFlow = await loadImapFlow();
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore cleanup errors */ }
  }
}

// ============================================================================
// Actions
// ============================================================================

interface ReadInboxParams {
  limit?: number;
  sinceDate?: string | null;
  sinceDays?: number | null;
}

async function readInbox(
  creds: ReturnType<typeof resolveCreds>,
  params: ReadInboxParams,
  start: number,
): Promise<ConnectorOutput> {
  const limit = params.limit ?? 10;
  const effectiveSince = resolveSinceDate(params.sinceDate, params.sinceDays);

  const messages = await withClient(creds, async (client) => {
    await client.mailboxOpen('INBOX');
    const searchCriteria: unknown = effectiveSince
      ? { since: new Date(effectiveSince) }
      : { all: true };
    return client.fetchAll(searchCriteria, {
      envelope: true,
      bodyStructure: true,
      uid: true,
      internalDate: true,
      size: true,
    });
  });

  // Newest first, then cap to limit.
  const sorted = [...messages].sort((a, b) => {
    const ta = new Date(a.internalDate ?? 0).getTime();
    const tb = new Date(b.internalDate ?? 0).getTime();
    return tb - ta;
  }).slice(0, limit);

  const rawEmails: (InboxEmail & { uid: number; sizeBytes: number })[] = sorted.map((m, i) => {
    const iso = toIso(m.internalDate) || toIso(m.envelope?.date);
    return {
      index: i,
      uid: m.uid,
      subject: m.envelope?.subject || '(no subject)',
      from: formatFrom(m.envelope),
      preview: '',
      hasAttachment: hasAttachment(m.bodyStructure),
      timestamp: iso,
      timestampIso: iso,
      sizeBytes: m.size ?? 0,
    };
  });

  const { kept, newestTimestamp } = filterEmailsSince(rawEmails, effectiveSince ?? undefined);

  return {
    success: true,
    data: {
      totalEmails: kept.length,
      emails: kept,
      emailsWithAttachments: kept.filter(e => e.hasAttachment).length,
      newestTimestamp,
      sinceDate: effectiveSince,
      totalBeforeFilter: rawEmails.length,
    },
    duration: Date.now() - start,
  };
}

interface DownloadParams {
  uid?: number;
  uids?: number[];
  downloadDir?: string;
}

async function downloadAttachments(
  creds: ReturnType<typeof resolveCreds>,
  params: DownloadParams,
  start: number,
): Promise<ConnectorOutput> {
  const uids = params.uids && params.uids.length > 0
    ? params.uids
    : typeof params.uid === 'number' ? [params.uid] : [];

  if (uids.length === 0) {
    return {
      success: false,
      data: {},
      error: 'download-attachments requires uid or uids',
      duration: Date.now() - start,
    };
  }

  const dir = resolveHome(params.downloadDir || DEFAULT_DOWNLOAD_DIR);
  await fs.mkdir(dir, { recursive: true });
  const simpleParser = await loadSimpleParser();

  const downloaded: string[] = await withClient(creds, async (client) => {
    await client.mailboxOpen('INBOX');
    const messages = await client.fetchAll(uids, { uid: true, source: true });
    const out: string[] = [];
    for (const msg of messages) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      for (const att of parsed.attachments ?? []) {
        if (!att.content) continue;
        const filename = att.filename || `attachment-${msg.uid}-${out.length + 1}`;
        const filePath = path.join(dir, `${msg.uid}-${filename}`);
        await fs.writeFile(filePath, att.content);
        out.push(filePath);
      }
    }
    return out;
  });

  return {
    success: true,
    data: { downloaded, count: downloaded.length },
    duration: Date.now() - start,
  };
}

// ============================================================================
// Action descriptors
// ============================================================================

const ACTIONS: ConnectorAction[] = [
  {
    name: 'read-inbox',
    description: 'Fetch recent INBOX messages via IMAP, optionally filtered by sinceDate',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return. Default: 10', default: 10 },
        sinceDate: { type: 'string', description: 'ISO datetime — only return emails at or after this moment' },
        sinceDays: { type: 'number', description: 'Fallback when sinceDate is absent — filter to emails newer than N days ago' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        totalEmails: { type: 'number' },
        emails: { type: 'array' },
        emailsWithAttachments: { type: 'number' },
        newestTimestamp: { type: 'string' },
        sinceDate: { type: 'string' },
        totalBeforeFilter: { type: 'number' },
      },
    },
  },
  {
    name: 'download-attachments',
    description: 'Fetch full source of one or more messages by UID and write every attachment to downloadDir',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: 'Single message UID' },
        uids: { type: 'array', items: { type: 'number' }, description: 'Multiple message UIDs' },
        downloadDir: { type: 'string', description: 'Target directory (default ~/Downloads/attachments)' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        downloaded: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
      },
    },
  },
];

// ============================================================================
// Factory
// ============================================================================

export function createImapConnector(): SpellConnector {
  let config: ImapConfig = {};

  return {
    name: 'imap',
    description:
      'IMAPS connector for reading inbox metadata and downloading attachments. ' +
      'Works with Outlook.com (outlook.office365.com) and any IMAPS server. ' +
      'Credentials resolve from connector config or IMAP_USER / IMAP_PASSWORD / IMAP_HOST / IMAP_PORT env.',
    version: '1.0.0',
    capabilities: ['read', 'write'],

    async initialize(cfg: Record<string, unknown>): Promise<void> {
      config = {
        user: typeof cfg.user === 'string' ? cfg.user : undefined,
        password: typeof cfg.password === 'string' ? cfg.password : undefined,
        host: typeof cfg.host === 'string' ? cfg.host : undefined,
        port: typeof cfg.port === 'number' ? cfg.port : undefined,
      };
    },

    async dispose(): Promise<void> {
      config = {};
    },

    async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
      const start = Date.now();
      const creds = resolveCreds(config);
      if (!creds.user || !creds.password) {
        return {
          success: false,
          data: {},
          error: 'Missing IMAP credentials. Set IMAP_USER and IMAP_PASSWORD env, or pass user/password to initialize().',
          duration: Date.now() - start,
        };
      }

      try {
        switch (action) {
          case 'read-inbox':
            return await readInbox(creds, params as ReadInboxParams, start);
          case 'download-attachments':
            return await downloadAttachments(creds, params as DownloadParams, start);
          default:
            return {
              success: false,
              data: {},
              error: `Unknown action "${action}". Available: read-inbox, download-attachments`,
              duration: Date.now() - start,
            };
        }
      } catch (err) {
        return {
          success: false,
          data: {},
          error: `imap: ${err instanceof Error ? err.message : String(err)}`,
          duration: Date.now() - start,
        };
      }
    },

    listActions(): ConnectorAction[] {
      return ACTIONS;
    },
  };
}

export const imapConnector: SpellConnector = createImapConnector();
