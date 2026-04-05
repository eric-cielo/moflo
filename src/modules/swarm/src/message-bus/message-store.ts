/**
 * MessageStore — Persistent message storage backed by memory DB.
 *
 * Cross-process, session-scoped, queryable message persistence.
 * Messages stored in `messages` namespace with key format: msg:{sessionId}:{channel}:{id}
 *
 * Story #111: Message Namespace Schema + CRUD
 * Story #115: Message History & Semantic Queryability
 */

import { randomBytes } from 'crypto';
import type {
  AgentMessage,
  IMessageStore,
  MessageSearchOptions,
  MessageSummarizeOptions,
  MessageSummary,
  MessageType,
  ScoredMessage,
} from '../types.js';
import type { MemoryStoreFunction, MemoryDeleteFunction } from './write-through-adapter.js';

/** Extended list function that returns full entry values */
export type MemoryListWithValueFunction = (options: {
  namespace: string;
  limit?: number;
}) => Promise<{
  entries: Array<{
    key: string;
    value?: string;
    metadata?: Record<string, unknown>;
  }>;
}>;

/** Memory retrieve function for single entry lookup */
export type MemoryRetrieveFunction = (options: {
  key: string;
  namespace: string;
}) => Promise<{ value?: string; metadata?: Record<string, unknown> } | null>;

/** Duck-typed embedding service — avoids hard dependency on @moflo/embeddings */
export interface EmbeddingFunction {
  embed(text: string): Promise<{ embedding: Float32Array | number[] }>;
}

export interface MessageStoreConfig {
  /** Memory DB store function */
  store: MemoryStoreFunction;
  /** Memory DB delete function */
  delete: MemoryDeleteFunction;
  /** Memory DB list function (with values) */
  list: MemoryListWithValueFunction;
  /** Memory DB retrieve function */
  retrieve: MemoryRetrieveFunction;
  /** Default session ID (can be overridden per message) */
  sessionId: string;
  /** Default TTL for session GC in ms (default: 24h) */
  sessionMaxAge?: number;
  /** Embedding service for semantic search (optional, Story #115) */
  embeddingService?: EmbeddingFunction;
}

const NAMESPACE = 'messages';
const DEFAULT_SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_LIST_LIMIT = 10_000;
const DEFAULT_SEARCH_THRESHOLD = 0.3;
const DEFAULT_SEARCH_LIMIT = 10;

/** Message types that are not worth embedding (noise, no semantic value) */
const SKIP_EMBEDDING_TYPES: Set<MessageType> = new Set([
  'heartbeat',
  'status_update',
  'agent_join',
  'agent_leave',
]);

export class MessageStore implements IMessageStore {
  private config: MessageStoreConfig;

  constructor(config: MessageStoreConfig) {
    this.config = config;
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(6).toString('hex');
    return `${timestamp}_${random}`;
  }

  private messageKey(sessionId: string, channel: string, id: string): string {
    return `msg:${sessionId}:${channel}:${id}`;
  }

  private buildTags(msg: AgentMessage): string[] {
    return [msg.channel, msg.type, `session:${msg.sessionId}`];
  }

  private async persistMessage(msg: AgentMessage, ttlSeconds?: number): Promise<void> {
    const key = this.messageKey(msg.sessionId, msg.channel, msg.id);
    await this.config.store({
      key,
      value: JSON.stringify(msg),
      namespace: NAMESPACE,
      tags: this.buildTags(msg),
      ttl: ttlSeconds,
      upsert: true,
    });
  }

  /** Extract embeddable text from a message (content field or stringified payload) */
  private getEmbeddableText(msg: AgentMessage): string | null {
    if (SKIP_EMBEDDING_TYPES.has(msg.type)) return null;
    if (msg.content) return msg.content;
    if (msg.payload && typeof msg.payload === 'object' && Object.keys(msg.payload).length > 0) {
      const text = JSON.stringify(msg.payload);
      if (text.length > 10) return text;
    }
    return null;
  }

  private async generateEmbedding(text: string): Promise<number[] | undefined> {
    if (!this.config.embeddingService) return undefined;
    try {
      const result = await this.config.embeddingService.embed(text);
      return Array.from(result.embedding);
    } catch {
      return undefined;
    }
  }

  async send(
    msg: Omit<AgentMessage, 'id' | 'createdAt' | 'readBy' | 'status'>,
  ): Promise<string> {
    const id = this.generateId();
    const message: AgentMessage = {
      ...msg,
      id,
      createdAt: Date.now(),
      readBy: [],
      status: 'pending',
    };

    // Generate embedding for semantic search if service available
    const text = this.getEmbeddableText(message);
    if (text) {
      message.embedding = await this.generateEmbedding(text);
    }

    const ttlSeconds = msg.ttlMs ? Math.ceil(msg.ttlMs / 1000) : undefined;
    await this.persistMessage(message, ttlSeconds);
    return id;
  }

  async receive(
    agentId: string,
    channel: string,
    opts?: { since?: number; unreadOnly?: boolean; limit?: number },
  ): Promise<AgentMessage[]> {
    const messages = await this.listChannelMessages(channel, this.config.sessionId);

    let filtered = messages.filter((m) => {
      if (m.to !== '*' && m.to !== agentId) return false;
      if (this.isExpired(m)) return false;
      if (opts?.since !== undefined && m.createdAt <= opts.since) return false;
      if (opts?.unreadOnly && m.readBy.includes(agentId)) return false;
      return true;
    });

    filtered.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    if (opts?.limit !== undefined) {
      filtered = filtered.slice(0, opts.limit);
    }

    return filtered;
  }

  async markRead(agentId: string, messageIds: string[]): Promise<void> {
    const sessionMessages = await this.listSessionMessages(this.config.sessionId);
    const byId = new Map(sessionMessages.map((m) => [m.id, m]));
    const writes: Promise<void>[] = [];

    for (const msgId of messageIds) {
      const message = byId.get(msgId);
      if (!message) continue;

      if (!message.readBy.includes(agentId)) {
        message.readBy.push(agentId);
      }
      if (message.to === agentId || message.to === '*') {
        message.status = 'read';
      }

      writes.push(this.persistMessage(message));
    }

    await Promise.all(writes);
  }

  async broadcast(
    channel: string,
    msg: Omit<AgentMessage, 'id' | 'createdAt' | 'readBy' | 'status' | 'to'>,
  ): Promise<string> {
    return this.send({ ...msg, to: '*', channel });
  }

  async getThread(replyTo: string): Promise<AgentMessage[]> {
    const allMessages = await this.listSessionMessages(this.config.sessionId);
    const thread: AgentMessage[] = [];

    const root = allMessages.find((m) => m.id === replyTo);
    if (root) thread.push(root);

    const childrenOf = new Map<string, AgentMessage[]>();
    for (const msg of allMessages) {
      if (msg.replyTo) {
        const list = childrenOf.get(msg.replyTo) ?? [];
        list.push(msg);
        childrenOf.set(msg.replyTo, list);
      }
    }

    const seen = new Set<string>([replyTo]);
    let frontier = [replyTo];

    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (const parentId of frontier) {
        for (const child of childrenOf.get(parentId) ?? []) {
          if (!seen.has(child.id)) {
            thread.push(child);
            seen.add(child.id);
            nextFrontier.push(child.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    thread.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return thread;
  }

  async expire(): Promise<number> {
    const allMessages = await this.listAllMessages();
    const toDelete = allMessages.filter((m) => this.isExpired(m));

    await Promise.all(
      toDelete.map((m) =>
        this.config.delete({
          key: this.messageKey(m.sessionId, m.channel, m.id),
          namespace: NAMESPACE,
        }),
      ),
    );

    return toDelete.length;
  }

  async channelHistory(channel: string, limit?: number): Promise<AgentMessage[]> {
    const messages = await this.listChannelMessages(channel, this.config.sessionId);
    const sorted = messages
      .filter((m) => !this.isExpired(m))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    return limit ? sorted.slice(-limit) : sorted;
  }

  async endSession(sessionId: string): Promise<number> {
    const messages = await this.listSessionMessages(sessionId);
    const toDelete = messages.filter((m) => m.status === 'pending' || m.status === 'delivered');

    await Promise.all(
      toDelete.map((m) =>
        this.config.delete({
          key: this.messageKey(m.sessionId, m.channel, m.id),
          namespace: NAMESPACE,
        }),
      ),
    );

    return toDelete.length;
  }

  async gc(maxAge?: number): Promise<number> {
    const age = maxAge ?? this.config.sessionMaxAge ?? DEFAULT_SESSION_MAX_AGE;
    const cutoff = Date.now() - age;
    const allMessages = await this.listAllMessages();
    const toDelete = allMessages.filter((m) => m.createdAt < cutoff);

    await Promise.all(
      toDelete.map((m) =>
        this.config.delete({
          key: this.messageKey(m.sessionId, m.channel, m.id),
          namespace: NAMESPACE,
        }),
      ),
    );

    return toDelete.length;
  }

  // === Semantic Search (Story #115) ===

  async search(query: string, opts?: MessageSearchOptions): Promise<ScoredMessage[]> {
    if (!this.config.embeddingService) {
      throw new Error('Embedding service required for semantic search');
    }

    const queryEmbedding = await this.generateEmbedding(query);
    if (!queryEmbedding) return [];

    const messages = await this.listSessionMessages(this.config.sessionId);
    const threshold = opts?.threshold ?? DEFAULT_SEARCH_THRESHOLD;
    const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT;

    const scored: ScoredMessage[] = [];

    for (const msg of messages) {
      if (!msg.embedding) continue;
      if (this.isExpired(msg)) continue;
      if (opts?.channel && msg.channel !== opts.channel) continue;
      if (opts?.type && msg.type !== opts.type) continue;
      if (opts?.from && msg.from !== opts.from) continue;
      if (opts?.since !== undefined && msg.createdAt <= opts.since) continue;

      const score = cosineSimilarity(queryEmbedding, msg.embedding);
      if (score >= threshold) {
        scored.push({ message: msg, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async summarize(channel: string, opts?: MessageSummarizeOptions): Promise<MessageSummary> {
    const messages = await this.listChannelMessages(channel, this.config.sessionId);
    const groupBy = opts?.groupBy ?? 'type';
    const groups: Record<string, number> = {};
    let earliest: number | undefined;
    let latest: number | undefined;
    let count = 0;

    for (const msg of messages) {
      if (this.isExpired(msg)) continue;
      if (opts?.since !== undefined && msg.createdAt <= opts.since) continue;

      count++;
      const key = groupBy === 'type' ? msg.type : msg.from;
      groups[key] = (groups[key] ?? 0) + 1;

      if (earliest === undefined || msg.createdAt < earliest) earliest = msg.createdAt;
      if (latest === undefined || msg.createdAt > latest) latest = msg.createdAt;
    }

    return { channel, totalMessages: count, groups, earliest, latest };
  }

  // === Private helpers ===

  private isExpired(msg: AgentMessage): boolean {
    if (!msg.ttlMs) return false;
    return Date.now() - msg.createdAt > msg.ttlMs;
  }

  private async listAllMessages(): Promise<AgentMessage[]> {
    const result = await this.config.list({ namespace: NAMESPACE, limit: MAX_LIST_LIMIT });
    return this.parseEntries(result.entries);
  }

  private async listSessionMessages(sessionId: string): Promise<AgentMessage[]> {
    const all = await this.listAllMessages();
    return all.filter((m) => m.sessionId === sessionId);
  }

  private async listChannelMessages(channel: string, sessionId: string): Promise<AgentMessage[]> {
    const all = await this.listAllMessages();
    return all.filter((m) => m.sessionId === sessionId && m.channel === channel);
  }

  private parseEntries(
    entries: Array<{ key: string; value?: string; metadata?: Record<string, unknown> }>,
  ): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const entry of entries) {
      if (!entry.value) continue;
      try {
        messages.push(JSON.parse(entry.value) as AgentMessage);
      } catch {
        // Skip malformed entries
      }
    }
    return messages;
  }
}

/** Cosine similarity between two vectors (0-1 range for normalized vectors) */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}
