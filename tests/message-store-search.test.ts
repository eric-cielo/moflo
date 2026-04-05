/**
 * Tests for Story #115: Message History & Semantic Queryability
 *
 * Covers:
 * - Embedding generation on send (text payloads get embeddings)
 * - Heartbeat/status messages skip embedding
 * - search() returns semantically relevant messages
 * - search() filters by channel, type, from, since
 * - search() throws without embedding service
 * - summarize() aggregates by type and from
 * - TTL-expired messages excluded from search/summarize
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../src/modules/swarm/src/message-bus/message-store.js';
import type { MessageStoreConfig, EmbeddingFunction } from '../src/modules/swarm/src/message-bus/message-store.js';

/** In-memory mock for Memory DB */
function createMockMemoryDb() {
  const storage = new Map<string, { value: string; tags?: string[]; ttl?: number }>();

  return {
    storage,
    store: async (opts: { key: string; value: string; namespace: string; tags?: string[]; ttl?: number; upsert?: boolean }) => {
      storage.set(`${opts.namespace}:${opts.key}`, { value: opts.value, tags: opts.tags, ttl: opts.ttl });
      return { success: true, id: opts.key };
    },
    delete: async (opts: { key: string; namespace: string }) => {
      storage.delete(`${opts.namespace}:${opts.key}`);
      return { success: true };
    },
    list: async (opts: { namespace: string; limit?: number }) => {
      const entries: Array<{ key: string; value?: string; metadata?: Record<string, unknown> }> = [];
      for (const [compositeKey, data] of storage) {
        if (compositeKey.startsWith(`${opts.namespace}:`)) {
          const key = compositeKey.slice(opts.namespace.length + 1);
          entries.push({ key, value: data.value });
        }
        if (opts.limit && entries.length >= opts.limit) break;
      }
      return { entries };
    },
    retrieve: async (opts: { key: string; namespace: string }) => {
      const data = storage.get(`${opts.namespace}:${opts.key}`);
      if (!data) return null;
      return { value: data.value };
    },
  };
}

/**
 * Mock embedding service that produces deterministic embeddings.
 * Uses a simple hash-based approach: each unique text gets a distinct vector.
 * Similar texts (sharing words) will have higher cosine similarity.
 */
function createMockEmbeddingService(): EmbeddingFunction & { callCount: number } {
  const cache = new Map<string, number[]>();
  let callCount = 0;

  return {
    get callCount() { return callCount; },
    async embed(text: string) {
      callCount++;
      if (cache.has(text)) {
        return { embedding: cache.get(text)! };
      }

      // Create a 16-dim embedding based on word hashes
      const dims = 16;
      const embedding = new Array(dims).fill(0);
      const words = text.toLowerCase().split(/\s+/);
      for (const word of words) {
        let hash = 0;
        for (let i = 0; i < word.length; i++) {
          hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
        }
        for (let d = 0; d < dims; d++) {
          embedding[d] += Math.sin(hash * (d + 1) * 0.1);
        }
      }
      // Normalize
      const norm = Math.sqrt(embedding.reduce((s: number, v: number) => s + v * v, 0));
      if (norm > 0) {
        for (let d = 0; d < dims; d++) embedding[d] /= norm;
      }

      cache.set(text, embedding);
      return { embedding };
    },
  };
}

function createStoreWithEmbeddings(sessionId = 'test-session') {
  const db = createMockMemoryDb();
  const embeddingService = createMockEmbeddingService();
  const config: MessageStoreConfig = {
    store: db.store,
    delete: db.delete,
    list: db.list,
    retrieve: db.retrieve,
    sessionId,
    embeddingService,
  };
  return { store: new MessageStore(config), db, embeddingService };
}

function createStoreWithoutEmbeddings(sessionId = 'test-session') {
  const db = createMockMemoryDb();
  const config: MessageStoreConfig = {
    store: db.store,
    delete: db.delete,
    list: db.list,
    retrieve: db.retrieve,
    sessionId,
  };
  return { store: new MessageStore(config), db };
}

describe('MessageStore — Semantic Search (Story #115)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1000000 });
  });

  // =========================================================================
  // Embedding generation on send
  // =========================================================================

  describe('embedding generation', () => {
    it('generates embeddings for messages with content', async () => {
      const { store, db } = createStoreWithEmbeddings();
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {},
        content: 'What is the authentication status?',
        sessionId: 'test-session',
      });

      // Check stored message has embedding
      const entries = [...db.storage.values()];
      const msg = JSON.parse(entries[0].value);
      expect(msg.embedding).toBeDefined();
      expect(msg.embedding.length).toBe(16);
    });

    it('generates embeddings for messages with meaningful payloads', async () => {
      const { store, db } = createStoreWithEmbeddings();
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'result',
        priority: 'normal',
        payload: { result: 'authentication succeeded', user: 'admin' },
        sessionId: 'test-session',
      });

      const entries = [...db.storage.values()];
      const msg = JSON.parse(entries[0].value);
      expect(msg.embedding).toBeDefined();
    });

    it('skips embedding for heartbeat messages', async () => {
      const { store, embeddingService } = createStoreWithEmbeddings();
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'heartbeat',
        priority: 'normal', payload: { alive: true },
        content: 'heartbeat ping',
        sessionId: 'test-session',
      });

      expect(embeddingService.callCount).toBe(0);
    });

    it('skips embedding for status_update messages', async () => {
      const { store, embeddingService } = createStoreWithEmbeddings();
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'status_update',
        priority: 'normal', payload: { status: 'running' },
        sessionId: 'test-session',
      });

      expect(embeddingService.callCount).toBe(0);
    });

    it('skips embedding for agent_join/agent_leave messages', async () => {
      const { store, embeddingService } = createStoreWithEmbeddings();
      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'agent_join',
        priority: 'normal', payload: {},
        sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'agent_leave',
        priority: 'normal', payload: {},
        sessionId: 'test-session',
      });

      expect(embeddingService.callCount).toBe(0);
    });

    it('works without embedding service (no embedding stored)', async () => {
      const { store, db } = createStoreWithoutEmbeddings();
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {},
        content: 'some content',
        sessionId: 'test-session',
      });

      const entries = [...db.storage.values()];
      const msg = JSON.parse(entries[0].value);
      expect(msg.embedding).toBeUndefined();
    });
  });

  // =========================================================================
  // search()
  // =========================================================================

  describe('search()', () => {
    it('returns semantically relevant messages ranked by score', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'researcher', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Authentication token validation failed for user admin',
        sessionId: 'test-session',
      });
      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'coder', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Database migration completed successfully',
        sessionId: 'test-session',
      });
      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'researcher', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'User authentication requires token refresh',
        sessionId: 'test-session',
      });

      const results = await store.search('authentication token');
      expect(results.length).toBeGreaterThan(0);
      // All results should have scores
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(r.message).toBeDefined();
      }
      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('filters by channel', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'security', from: 'a', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Authentication check passed',
        sessionId: 'test-session',
      });
      await store.send({
        channel: 'database', from: 'b', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Authentication table updated',
        sessionId: 'test-session',
      });

      const results = await store.search('authentication', { channel: 'security' });
      for (const r of results) {
        expect(r.message.channel).toBe('security');
      }
    });

    it('filters by type', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'query',
        priority: 'normal', payload: {},
        content: 'What is the authentication status?',
        sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'b', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Authentication is working fine',
        sessionId: 'test-session',
      });

      const results = await store.search('authentication', { type: 'result' });
      for (const r of results) {
        expect(r.message.type).toBe('result');
      }
    });

    it('filters by from', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'researcher', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Found authentication bug',
        sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'coder', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Fixed authentication bug',
        sessionId: 'test-session',
      });

      const results = await store.search('authentication', { from: 'researcher' });
      for (const r of results) {
        expect(r.message.from).toBe('researcher');
      }
    });

    it('respects threshold filter', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Completely unrelated topic about cooking recipes',
        sessionId: 'test-session',
      });

      const results = await store.search('authentication security', { threshold: 0.9 });
      // With high threshold, unrelated content should be filtered out
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('limits results', async () => {
      const { store } = createStoreWithEmbeddings();

      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1);
        await store.send({
          channel: 'ch', from: 'a', to: '*', type: 'result',
          priority: 'normal', payload: {},
          content: `Authentication check number ${i}`,
          sessionId: 'test-session',
        });
      }

      const results = await store.search('authentication', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('excludes expired messages', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Authentication expired message',
        ttlMs: 100,
        sessionId: 'test-session',
      });

      vi.advanceTimersByTime(200);
      const results = await store.search('authentication');
      expect(results).toHaveLength(0);
    });

    it('throws error without embedding service', async () => {
      const { store } = createStoreWithoutEmbeddings();

      await expect(store.search('query')).rejects.toThrow('Embedding service required');
    });

    it('skips messages without embeddings', async () => {
      const { store } = createStoreWithEmbeddings();

      // Heartbeat has no embedding
      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'heartbeat',
        priority: 'normal', payload: { alive: true },
        sessionId: 'test-session',
      });
      // This one has an embedding
      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'result',
        priority: 'normal', payload: {},
        content: 'Some actual content',
        sessionId: 'test-session',
      });

      const results = await store.search('content');
      // Only the result message should appear, not the heartbeat
      for (const r of results) {
        expect(r.message.type).not.toBe('heartbeat');
      }
    });
  });

  // =========================================================================
  // summarize()
  // =========================================================================

  describe('summarize()', () => {
    it('aggregates by type (default)', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'query',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'b', to: 'a', type: 'result',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'query',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      const summary = await store.summarize('ch');
      expect(summary.channel).toBe('ch');
      expect(summary.totalMessages).toBe(3);
      expect(summary.groups['query']).toBe(2);
      expect(summary.groups['result']).toBe(1);
      expect(summary.earliest).toBeDefined();
      expect(summary.latest).toBeDefined();
      expect(summary.earliest!).toBeLessThan(summary.latest!);
    });

    it('aggregates by from', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'alice', to: '*', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'bob', to: '*', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'alice', to: '*', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      const summary = await store.summarize('ch', { groupBy: 'from' });
      expect(summary.groups['alice']).toBe(2);
      expect(summary.groups['bob']).toBe(1);
    });

    it('filters by since', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(100);
      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      const summary = await store.summarize('ch', { since: 1000000 });
      expect(summary.totalMessages).toBe(1);
    });

    it('excludes expired messages', async () => {
      const { store } = createStoreWithEmbeddings();

      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'direct',
        priority: 'normal', payload: {}, ttlMs: 50,
        sessionId: 'test-session',
      });
      vi.advanceTimersByTime(100);
      await store.send({
        channel: 'ch', from: 'a', to: '*', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      const summary = await store.summarize('ch');
      expect(summary.totalMessages).toBe(1);
    });

    it('returns zero summary for empty channel', async () => {
      const { store } = createStoreWithEmbeddings();

      const summary = await store.summarize('nonexistent-channel');
      expect(summary.totalMessages).toBe(0);
      expect(summary.groups).toEqual({});
      expect(summary.earliest).toBeUndefined();
      expect(summary.latest).toBeUndefined();
    });
  });
});
