/**
 * Tests for Story #111: Message Namespace Schema + CRUD
 *
 * Covers:
 * - AgentMessage type fields
 * - MessageStore send/receive/markRead/broadcast
 * - getThread (conversation threading)
 * - expire (TTL cleanup)
 * - channelHistory
 * - Session isolation (endSession, gc)
 * - Message ordering (createdAt + id tiebreaker)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageStore } from '../src/modules/cli/src/swarm/message-bus/message-store.js';
import type { MessageStoreConfig } from '../src/modules/cli/src/swarm/message-bus/message-store.js';
import type { AgentMessage } from '../src/modules/cli/src/swarm/types.js';

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

function createStore(sessionId = 'test-session'): { store: MessageStore; db: ReturnType<typeof createMockMemoryDb> } {
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

describe('MessageStore — Schema + CRUD (Story #111)', () => {
  let store: MessageStore;
  let db: ReturnType<typeof createMockMemoryDb>;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1000000 });
    ({ store, db } = createStore());
  });

  // =========================================================================
  // send()
  // =========================================================================

  describe('send()', () => {
    it('stores a message and returns an ID', async () => {
      const id = await store.send({
        channel: 'swarm:abc',
        from: 'agent-1',
        to: 'agent-2',
        type: 'task_assign',
        priority: 'normal',
        payload: { task: 'build' },
        sessionId: 'test-session',
      });

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      expect(db.storage.size).toBe(1);
    });

    it('sets default fields: readBy=[], status=pending, createdAt=now', async () => {
      const id = await store.send({
        channel: 'swarm:abc',
        from: 'agent-1',
        to: 'agent-2',
        type: 'task_assign',
        priority: 'normal',
        payload: {},
        sessionId: 'test-session',
      });

      const messages = await store.receive('agent-2', 'swarm:abc');
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(id);
      expect(messages[0].readBy).toEqual([]);
      expect(messages[0].status).toBe('pending');
      expect(messages[0].createdAt).toBe(1000000);
    });

    it('persists all AgentMessage fields', async () => {
      await store.send({
        channel: 'hive:consensus',
        from: 'queen',
        to: 'worker-3',
        type: 'consensus_propose',
        priority: 'urgent',
        payload: { proposal: 'merge' },
        content: 'Propose merge',
        replyTo: 'prev-msg-id',
        ttlMs: 30000,
        sessionId: 'test-session',
      });

      const msgs = await store.receive('worker-3', 'hive:consensus');
      expect(msgs[0].channel).toBe('hive:consensus');
      expect(msgs[0].from).toBe('queen');
      expect(msgs[0].to).toBe('worker-3');
      expect(msgs[0].type).toBe('consensus_propose');
      expect(msgs[0].priority).toBe('urgent');
      expect(msgs[0].payload).toEqual({ proposal: 'merge' });
      expect(msgs[0].content).toBe('Propose merge');
      expect(msgs[0].replyTo).toBe('prev-msg-id');
      expect(msgs[0].ttlMs).toBe(30000);
    });

    it('generates unique IDs for each message', async () => {
      const id1 = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      const id2 = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      expect(id1).not.toBe(id2);
    });
  });

  // =========================================================================
  // receive()
  // =========================================================================

  describe('receive()', () => {
    it('receives messages addressed to the agent', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { n: 1 }, sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'a', to: 'c', type: 'direct',
        priority: 'normal', payload: { n: 2 }, sessionId: 'test-session',
      });

      const msgs = await store.receive('b', 'ch');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload).toEqual({ n: 1 });
    });

    it('receives broadcast messages', async () => {
      await store.broadcast('ch', {
        from: 'orchestrator', type: 'broadcast',
        priority: 'normal', payload: { info: 'hello' }, sessionId: 'test-session',
      });

      const msgs = await store.receive('any-agent', 'ch');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].to).toBe('*');
    });

    it('filters by since timestamp', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { n: 1 }, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(100);
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { n: 2 }, sessionId: 'test-session',
      });

      const msgs = await store.receive('b', 'ch', { since: 1000000 });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload).toEqual({ n: 2 });
    });

    it('filters unread only', async () => {
      const id = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      await store.markRead('b', [id]);

      const unread = await store.receive('b', 'ch', { unreadOnly: true });
      expect(unread).toHaveLength(0);

      const all = await store.receive('b', 'ch');
      expect(all).toHaveLength(1);
    });

    it('limits results', async () => {
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(1);
        await store.send({
          channel: 'ch', from: 'a', to: 'b', type: 'direct',
          priority: 'normal', payload: { n: i }, sessionId: 'test-session',
        });
      }

      const msgs = await store.receive('b', 'ch', { limit: 3 });
      expect(msgs).toHaveLength(3);
      // Should be ordered by createdAt
      expect(msgs[0].payload).toEqual({ n: 0 });
      expect(msgs[2].payload).toEqual({ n: 2 });
    });

    it('excludes expired messages', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { expired: true },
        ttlMs: 100, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(200);

      const msgs = await store.receive('b', 'ch');
      expect(msgs).toHaveLength(0);
    });

    it('orders by createdAt ascending', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { n: 1 }, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(100);
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { n: 2 }, sessionId: 'test-session',
      });

      const msgs = await store.receive('b', 'ch');
      expect(msgs).toHaveLength(2);
      expect(msgs[0].payload).toEqual({ n: 1 });
      expect(msgs[1].payload).toEqual({ n: 2 });
      expect(msgs[0].createdAt).toBeLessThan(msgs[1].createdAt);
    });
  });

  // =========================================================================
  // markRead()
  // =========================================================================

  describe('markRead()', () => {
    it('adds agent to readBy array', async () => {
      const id = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      await store.markRead('b', [id]);
      const msgs = await store.receive('b', 'ch');
      expect(msgs[0].readBy).toContain('b');
    });

    it('updates status to read for intended recipient', async () => {
      const id = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      await store.markRead('b', [id]);
      const msgs = await store.receive('b', 'ch');
      expect(msgs[0].status).toBe('read');
    });

    it('does not duplicate readBy entries', async () => {
      const id = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      await store.markRead('b', [id]);
      await store.markRead('b', [id]);
      const msgs = await store.receive('b', 'ch');
      expect(msgs[0].readBy.filter((r: string) => r === 'b')).toHaveLength(1);
    });
  });

  // =========================================================================
  // broadcast()
  // =========================================================================

  describe('broadcast()', () => {
    it('sends with to=* on the specified channel', async () => {
      const id = await store.broadcast('swarm:updates', {
        from: 'orchestrator', type: 'status_update',
        priority: 'normal', payload: { status: 'running' }, sessionId: 'test-session',
      });

      expect(id).toBeTruthy();
      const msgs = await store.receive('any-agent', 'swarm:updates');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].to).toBe('*');
      expect(msgs[0].channel).toBe('swarm:updates');
    });
  });

  // =========================================================================
  // getThread()
  // =========================================================================

  describe('getThread()', () => {
    it('returns root message and all replies', async () => {
      const rootId = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'query',
        priority: 'normal', payload: { q: 'status?' }, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'b', to: 'a', type: 'result',
        priority: 'normal', payload: { a: 'ok' },
        replyTo: rootId, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'result',
        priority: 'normal', payload: { a: 'thanks' },
        replyTo: rootId, sessionId: 'test-session',
      });

      const thread = await store.getThread(rootId);
      expect(thread).toHaveLength(3);
      expect(thread[0].id).toBe(rootId);
      expect(thread[0].createdAt).toBeLessThan(thread[1].createdAt);
    });

    it('returns transitive replies (nested threads)', async () => {
      const rootId = await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'query',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(10);
      const replyId = await store.send({
        channel: 'ch', from: 'b', to: 'a', type: 'result',
        priority: 'normal', payload: {},
        replyTo: rootId, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(10);
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'result',
        priority: 'normal', payload: {},
        replyTo: replyId, sessionId: 'test-session',
      });

      const thread = await store.getThread(rootId);
      expect(thread).toHaveLength(3);
    });

    it('returns empty array for unknown replyTo', async () => {
      const thread = await store.getThread('nonexistent-id');
      expect(thread).toEqual([]);
    });
  });

  // =========================================================================
  // expire()
  // =========================================================================

  describe('expire()', () => {
    it('removes TTL-expired messages', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, ttlMs: 100, sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(200);
      const count = await store.expire();
      expect(count).toBe(1);

      // Non-expired message still accessible
      const msgs = await store.receive('b', 'ch');
      expect(msgs).toHaveLength(1);
    });
  });

  // =========================================================================
  // channelHistory()
  // =========================================================================

  describe('channelHistory()', () => {
    it('returns messages for a channel sorted by time', async () => {
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(1);
        await store.send({
          channel: 'history-ch', from: 'a', to: 'b', type: 'direct',
          priority: 'normal', payload: { n: i }, sessionId: 'test-session',
        });
      }

      const history = await store.channelHistory('history-ch');
      expect(history).toHaveLength(5);
      expect(history[0].createdAt).toBeLessThan(history[4].createdAt);
    });

    it('limits to last N messages', async () => {
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(1);
        await store.send({
          channel: 'ch', from: 'a', to: 'b', type: 'direct',
          priority: 'normal', payload: { n: i }, sessionId: 'test-session',
        });
      }

      const history = await store.channelHistory('ch', 3);
      expect(history).toHaveLength(3);
      // Last 3 messages
      expect(history[0].payload).toEqual({ n: 2 });
      expect(history[2].payload).toEqual({ n: 4 });
    });

    it('excludes expired messages', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, ttlMs: 50, sessionId: 'test-session',
      });
      vi.advanceTimersByTime(100);
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      const history = await store.channelHistory('ch');
      expect(history).toHaveLength(1);
    });
  });

  // =========================================================================
  // Session isolation
  // =========================================================================

  describe('session isolation', () => {
    it('receive() only returns messages from current session', async () => {
      // Message in different session
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { session: 'other' },
        sessionId: 'other-session',
      });
      // Message in current session
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { session: 'current' },
        sessionId: 'test-session',
      });

      const msgs = await store.receive('b', 'ch');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload).toEqual({ session: 'current' });
    });

    it('endSession() expires all unhandled messages', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });
      await store.send({
        channel: 'ch', from: 'a', to: 'c', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      const count = await store.endSession('test-session');
      expect(count).toBe(2);

      // Messages should be gone
      const msgs = await store.receive('b', 'ch');
      expect(msgs).toHaveLength(0);
    });

    it('endSession() does not affect other sessions', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'session-keep',
      });
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'session-end',
      });

      await store.endSession('session-end');

      // Create a new store with the kept session to check
      const { store: keepStore } = createStore('session-keep');
      // Re-use same DB by recreating — but since endSession only deletes session-end,
      // the session-keep message should still be in the mock DB
      // We need to verify via db.storage
      let keepMessages = 0;
      for (const [, data] of db.storage) {
        const parsed = JSON.parse(data.value) as AgentMessage;
        if (parsed.sessionId === 'session-keep') keepMessages++;
      }
      expect(keepMessages).toBe(1);
    });
  });

  // =========================================================================
  // gc()
  // =========================================================================

  describe('gc()', () => {
    it('removes messages older than maxAge', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { old: true }, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { new: true }, sessionId: 'test-session',
      });

      // GC with 30 min maxAge
      const removed = await store.gc(30 * 60 * 1000);
      expect(removed).toBe(1);
    });

    it('uses default 24h maxAge when not specified', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours
      const removed = await store.gc();
      expect(removed).toBe(1);
    });

    it('keeps messages within maxAge', async () => {
      await store.send({
        channel: 'ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: {}, sessionId: 'test-session',
      });

      vi.advanceTimersByTime(1000); // 1 second
      const removed = await store.gc();
      expect(removed).toBe(0);
    });
  });

  // =========================================================================
  // Persistence
  // =========================================================================

  describe('persistence', () => {
    it('messages survive across MessageStore instances (same DB)', async () => {
      await store.send({
        channel: 'persist-ch', from: 'a', to: 'b', type: 'direct',
        priority: 'normal', payload: { persisted: true }, sessionId: 'test-session',
      });

      // Create new store with same DB
      const config: MessageStoreConfig = {
        store: db.store,
        delete: db.delete,
        list: db.list,
        retrieve: db.retrieve,
        sessionId: 'test-session',
      };
      const store2 = new MessageStore(config);
      const msgs = await store2.receive('b', 'persist-ch');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload).toEqual({ persisted: true });
    });
  });
});
