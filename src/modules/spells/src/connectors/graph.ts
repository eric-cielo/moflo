/**
 * Microsoft Graph Mail Connector — read inbox + download attachments via
 * direct REST calls. Uses a bearer token from GRAPH_ACCESS_TOKEN env or
 * connector config. Token source agnostic: Graph Explorer, OAuth flow,
 * whatever — just needs a valid Bearer token with Mail.Read.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

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

interface GraphConnectorConfig {
  accessToken?: string;
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  hasAttachments?: boolean;
  bodyPreview?: string;
}

interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TIMEOUT = 30_000;

function resolveHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    return p.replace('~', home);
  }
  return p;
}

function sanitizeFilename(name: string): string {
  // Strip control chars + filesystem-reserved characters; cap length.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 200);
}

const ACTIONS: ConnectorAction[] = [
  {
    name: 'read-inbox',
    description: 'List recent messages via /me/messages with sinceDate filter',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        sinceDate: { type: 'string' },
        sinceDays: { type: 'number' },
        accessToken: { type: 'string' },
        timeout: { type: 'number' },
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
    description: 'Download non-inline attachments of a single message to disk',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        downloadDir: { type: 'string' },
        accessToken: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      properties: { downloaded: { type: 'array' }, count: { type: 'number' } },
    },
  },
];

async function graphGet<T>(path: string, token: string, timeoutMs: number): Promise<T> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<T>;
}

async function graphGetBytes(path: string, token: string, timeoutMs: number): Promise<Buffer> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph ${response.status}: ${body.slice(0, 400)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function mapMessage(m: GraphMessage, index: number): InboxEmail & { id: string } {
  const addr = m.from?.emailAddress?.address ?? '';
  const name = m.from?.emailAddress?.name ?? '';
  const from = name && addr ? `${name} <${addr}>` : addr || name || '(unknown)';
  const iso = m.receivedDateTime ?? '';
  return {
    index,
    subject: m.subject ?? '(no subject)',
    from,
    preview: m.bodyPreview?.slice(0, 150) ?? '',
    hasAttachment: Boolean(m.hasAttachments),
    timestamp: iso,
    timestampIso: iso,
    id: m.id,
  };
}

async function readInbox(
  token: string,
  params: { limit?: number; sinceDate?: string | null; sinceDays?: number | null; timeout?: number },
  start: number,
): Promise<ConnectorOutput> {
  const limit = params.limit ?? 25;
  const effectiveSince = resolveSinceDate(params.sinceDate, params.sinceDays);
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;

  const parts = [
    `$top=${limit}`,
    `$orderby=receivedDateTime desc`,
    `$select=id,subject,from,receivedDateTime,hasAttachments,bodyPreview`,
  ];
  if (effectiveSince) parts.push(`$filter=receivedDateTime ge ${effectiveSince}`);

  let raw: { value: GraphMessage[] };
  try {
    raw = await graphGet<{ value: GraphMessage[] }>(`/me/messages?${parts.join('&')}`, token, timeout);
  } catch (err) {
    return {
      success: false,
      data: {},
      error: `Graph read-inbox failed: ${(err as Error).message}`,
      duration: Date.now() - start,
    };
  }

  const mapped = (raw.value ?? []).map((m, i) => mapMessage(m, i));
  const { kept, newestTimestamp } = filterEmailsSince(mapped, effectiveSince ?? undefined);

  return {
    success: true,
    data: {
      totalEmails: kept.length,
      emails: kept,
      emailsWithAttachments: kept.filter(e => e.hasAttachment).length,
      newestTimestamp,
      sinceDate: effectiveSince,
      totalBeforeFilter: mapped.length,
    },
    duration: Date.now() - start,
  };
}

async function downloadAttachments(
  token: string,
  params: { id?: string; downloadDir?: string; timeout?: number },
  start: number,
): Promise<ConnectorOutput> {
  if (!params.id) {
    return { success: false, data: {}, error: 'Missing required parameter: id', duration: Date.now() - start };
  }
  const timeout = params.timeout ?? DEFAULT_TIMEOUT;
  const downloadDir = resolveHome(params.downloadDir || '~/Downloads/attachments');

  let atts: { value: GraphAttachment[] };
  try {
    atts = await graphGet<{ value: GraphAttachment[] }>(
      `/me/messages/${encodeURIComponent(params.id)}/attachments?$select=id,name,contentType,size,isInline`,
      token,
      timeout,
    );
  } catch (err) {
    return {
      success: false,
      data: {},
      error: `Graph list-attachments failed: ${(err as Error).message}`,
      duration: Date.now() - start,
    };
  }

  const downloaded: string[] = [];
  try {
    await mkdir(downloadDir, { recursive: true });
    for (const a of atts.value ?? []) {
      if (a.isInline) continue;
      const filename = sanitizeFilename(a.name || `${a.id}.bin`);
      const path = `${downloadDir}/${params.id.slice(0, 16)}-${filename}`;
      await mkdir(dirname(path), { recursive: true });

      const bytes = a.contentBytes
        ? Buffer.from(a.contentBytes, 'base64')
        : await graphGetBytes(
            `/me/messages/${encodeURIComponent(params.id)}/attachments/${encodeURIComponent(a.id)}/$value`,
            token,
            timeout,
          );
      await writeFile(path, bytes);
      downloaded.push(path);
    }
  } catch (err) {
    return {
      success: false,
      data: { downloaded },
      error: `Graph download-attachments failed: ${(err as Error).message}`,
      duration: Date.now() - start,
    };
  }

  return { success: true, data: { downloaded, count: downloaded.length }, duration: Date.now() - start };
}

export function createGraphConnector(): SpellConnector {
  let config: GraphConnectorConfig = {};

  return {
    name: 'graph',
    description:
      'Microsoft Graph Mail connector. Bearer token from GRAPH_ACCESS_TOKEN env ' +
      'or connector config. Get a token quickly from Graph Explorer for testing.',
    version: '1.0.0',
    capabilities: ['read', 'write'],

    async initialize(cfg: Record<string, unknown>): Promise<void> {
      config = { accessToken: typeof cfg.accessToken === 'string' ? cfg.accessToken : undefined };
    },

    async dispose(): Promise<void> {
      config = {};
    },

    async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
      const start = Date.now();
      const token = (params as { accessToken?: string }).accessToken
        || config.accessToken
        || process.env.GRAPH_ACCESS_TOKEN;
      if (!token) {
        return {
          success: false,
          data: {},
          error: 'Missing Graph access token. Set GRAPH_ACCESS_TOKEN env or pass accessToken.',
          duration: Date.now() - start,
        };
      }
      try {
        switch (action) {
          case 'read-inbox':
            return await readInbox(token, params as { limit?: number; sinceDate?: string | null; sinceDays?: number | null; timeout?: number }, start);
          case 'download-attachments':
            return await downloadAttachments(token, params as { id?: string; downloadDir?: string; timeout?: number }, start);
          default:
            return { success: false, data: {}, error: `Unknown action "${action}". Available: read-inbox, download-attachments`, duration: Date.now() - start };
        }
      } catch (err) {
        return { success: false, data: {}, error: (err as Error).message, duration: Date.now() - start };
      }
    },

    listActions(): ConnectorAction[] {
      return ACTIONS;
    },
  };
}

export const graphConnector: SpellConnector = createGraphConnector();
