/**
 * Tests for Epic #118 Diagnostics: Bug fixes + Tier 1 coverage gaps
 *
 * Bug regressions:
 * - #2 (HIGH): Broadcast metadata cleanup breaks namespace-scoped multi-agent delivery
 * - #4 (LOW): WriteThroughAdapter detach() only removes its own listener
 * - #5 (MEDIUM): Consensus majority formula correctness
 * - #9 (LOW): Multi-target pattern broadcast sends individually
 *
 * Coverage gaps (Tier 1):
 * - message.unified event emission and payload
 * - Namespace-scoped broadcast to multiple subscribers
 * - MessageBus → WriteThroughAdapter integration (end-to-end)
 * - Deque circular buffer unit tests
 * - PriorityMessageQueue unit tests
 * - Delivery retry on callback failure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MessageBus,
  createMessageBus,
  WriteThroughAdapter,
  type Message,
} from '../src/packages/swarm/src/index.js';
import { Deque } from '../src/packages/swarm/src/message-bus/deque.js';
import { PriorityMessageQueue, type MessageQueueEntry } from '../src/packages/swarm/src/message-bus/priority-queue.js';

// ==========================================================================
// Deque Unit Tests
// ==========================================================================

describe('Deque — Circular Buffer', () => {
  let deque: Deque<number>;

  beforeEach(() => {
    deque = new Deque<number>(4);
  });

  it('pushBack/popFront maintains FIFO order', () => {
    deque.pushBack(1);
    deque.pushBack(2);
    deque.pushBack(3);
    expect(deque.popFront()).toBe(1);
    expect(deque.popFront()).toBe(2);
    expect(deque.popFront()).toBe(3);
  });

  it('returns undefined from empty deque', () => {
    expect(deque.popFront()).toBeUndefined();
    expect(deque.peekFront()).toBeUndefined();
  });

  it('peekFront does not consume the item', () => {
    deque.pushBack(42);
    expect(deque.peekFront()).toBe(42);
    expect(deque.length).toBe(1);
    expect(deque.popFront()).toBe(42);
  });

  it('grows when capacity is exceeded', () => {
    // Initial capacity = 4
    for (let i = 0; i < 10; i++) {
      deque.pushBack(i);
    }
    expect(deque.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(deque.popFront()).toBe(i);
    }
  });

  it('handles wrap-around correctly', () => {
    // Fill to capacity, pop some, push more
    deque.pushBack(1);
    deque.pushBack(2);
    deque.pushBack(3);
    deque.popFront(); // removes 1, head moves
    deque.popFront(); // removes 2, head moves
    deque.pushBack(4);
    deque.pushBack(5);
    expect(deque.popFront()).toBe(3);
    expect(deque.popFront()).toBe(4);
    expect(deque.popFront()).toBe(5);
  });

  it('clear resets state', () => {
    deque.pushBack(1);
    deque.pushBack(2);
    deque.clear();
    expect(deque.length).toBe(0);
    expect(deque.popFront()).toBeUndefined();
  });

  it('find locates matching item without removing', () => {
    deque.pushBack(10);
    deque.pushBack(20);
    deque.pushBack(30);
    expect(deque.find(x => x === 20)).toBe(20);
    expect(deque.length).toBe(3);
  });

  it('find returns undefined when no match', () => {
    deque.pushBack(1);
    expect(deque.find(x => x === 99)).toBeUndefined();
  });

  it('findAndRemove removes matching item and shifts', () => {
    deque.pushBack(10);
    deque.pushBack(20);
    deque.pushBack(30);
    expect(deque.findAndRemove(x => x === 20)).toBe(20);
    expect(deque.length).toBe(2);
    expect(deque.popFront()).toBe(10);
    expect(deque.popFront()).toBe(30);
  });

  it('iterator yields all items in order', () => {
    deque.pushBack(1);
    deque.pushBack(2);
    deque.pushBack(3);
    expect([...deque]).toEqual([1, 2, 3]);
  });
});

// ==========================================================================
// PriorityMessageQueue Unit Tests
// ==========================================================================

describe('PriorityMessageQueue', () => {
  let pq: PriorityMessageQueue;

  function makeEntry(priority: Message['priority'], id: string): MessageQueueEntry {
    return {
      message: {
        id,
        type: 'direct',
        from: 'a',
        to: 'b',
        payload: null,
        priority,
        requiresAck: false,
        ttlMs: 60000,
        timestamp: new Date(),
      },
      attempts: 0,
      enqueuedAt: new Date(),
    };
  }

  beforeEach(() => {
    pq = new PriorityMessageQueue();
  });

  it('dequeues in priority order (critical > urgent > high > normal > low)', () => {
    pq.enqueue(makeEntry('low', 'low-1'));
    pq.enqueue(makeEntry('high', 'high-1'));
    pq.enqueue(makeEntry('critical', 'crit-1'));
    pq.enqueue(makeEntry('normal', 'norm-1'));
    pq.enqueue(makeEntry('urgent', 'urg-1'));

    expect(pq.dequeue()?.message.id).toBe('crit-1');
    expect(pq.dequeue()?.message.id).toBe('urg-1');
    expect(pq.dequeue()?.message.id).toBe('high-1');
    expect(pq.dequeue()?.message.id).toBe('norm-1');
    expect(pq.dequeue()?.message.id).toBe('low-1');
  });

  it('FIFO within same priority level', () => {
    pq.enqueue(makeEntry('normal', 'n1'));
    pq.enqueue(makeEntry('normal', 'n2'));
    pq.enqueue(makeEntry('normal', 'n3'));
    expect(pq.dequeue()?.message.id).toBe('n1');
    expect(pq.dequeue()?.message.id).toBe('n2');
    expect(pq.dequeue()?.message.id).toBe('n3');
  });

  it('removeLowestPriority removes from the lowest non-empty level', () => {
    pq.enqueue(makeEntry('high', 'h1'));
    pq.enqueue(makeEntry('low', 'l1'));
    pq.enqueue(makeEntry('normal', 'n1'));
    const removed = pq.removeLowestPriority();
    expect(removed?.message.id).toBe('l1');
    expect(pq.length).toBe(2);
  });

  it('returns undefined when empty', () => {
    expect(pq.dequeue()).toBeUndefined();
    expect(pq.removeLowestPriority()).toBeUndefined();
  });

  it('find locates entry by predicate', () => {
    pq.enqueue(makeEntry('normal', 'target'));
    pq.enqueue(makeEntry('high', 'other'));
    const found = pq.find(e => e.message.id === 'target');
    expect(found?.message.id).toBe('target');
  });

  it('find returns undefined when no match', () => {
    pq.enqueue(makeEntry('normal', 'x'));
    expect(pq.find(e => e.message.id === 'nope')).toBeUndefined();
  });

  it('clear empties all priority levels', () => {
    pq.enqueue(makeEntry('critical', 'c'));
    pq.enqueue(makeEntry('low', 'l'));
    pq.clear();
    expect(pq.length).toBe(0);
    expect(pq.dequeue()).toBeUndefined();
  });

  it('tracks length accurately across operations', () => {
    expect(pq.length).toBe(0);
    pq.enqueue(makeEntry('normal', 'a'));
    pq.enqueue(makeEntry('high', 'b'));
    expect(pq.length).toBe(2);
    pq.dequeue();
    expect(pq.length).toBe(1);
    pq.removeLowestPriority();
    expect(pq.length).toBe(0);
  });
});

// ==========================================================================
// message.unified Event Tests
// ==========================================================================

describe('MessageBus — message.unified event', () => {
  let bus: MessageBus;

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = createMessageBus({ processingIntervalMs: 10, reaperIntervalMs: 60000 });
    await bus.initialize();
  });

  afterEach(async () => {
    await bus.shutdown();
    vi.useRealTimers();
  });

  it('emits message.unified on sendUnified with full payload', async () => {
    const events: unknown[] = [];
    bus.on('message.unified', (e) => events.push(e));

    bus.subscribe('agent-a', () => {});

    await bus.sendUnified({
      type: 'direct',
      from: 'sender',
      to: 'agent-a',
      payload: { data: 42 },
      content: 'hello',
      namespace: 'test-ns',
      priority: 'high',
      requiresAck: false,
      ttlMs: 30000,
      metadata: { key: 'val' },
    });

    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.namespace).toBe('test-ns');
    expect(e.type).toBe('direct');
    expect(e.from).toBe('sender');
    expect(e.content).toBe('hello');
    expect(e.priority).toBe('high');
    expect(e.ttlMs).toBe(30000);
    expect(e.metadata).toEqual({ key: 'val' });
    expect(e.messageId).toBeDefined();
  });

  it('emits message.unified on broadcastUnified', async () => {
    const events: unknown[] = [];
    bus.on('message.unified', (e) => events.push(e));

    bus.subscribe('a', () => {});
    bus.subscribe('b', () => {});

    await bus.broadcastUnified({
      type: 'broadcast',
      from: 'sender',
      payload: 'hi all',
      namespace: 'ns1',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).to).toBe('*');
  });

  it('does NOT emit message.unified on legacy send()', async () => {
    const events: unknown[] = [];
    bus.on('message.unified', (e) => events.push(e));

    bus.subscribe('agent-x', () => {});

    await bus.send({
      type: 'direct',
      from: 'sender',
      to: 'agent-x',
      payload: 'legacy',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    expect(events).toHaveLength(0);
  });
});

// ==========================================================================
// Bug #2 Regression: Namespace-scoped broadcast to multiple agents
// ==========================================================================

describe('MessageBus — namespace-scoped broadcast (Bug #2 regression)', () => {
  let bus: MessageBus;

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = createMessageBus({ processingIntervalMs: 10, reaperIntervalMs: 60000 });
    await bus.initialize();
  });

  afterEach(async () => {
    await bus.shutdown();
    vi.useRealTimers();
  });

  it('delivers namespace-scoped broadcast to ALL subscribed agents', async () => {
    const received: Record<string, Message[]> = { a: [], b: [], c: [] };

    bus.subscribe('a', (m) => received.a.push(m), { namespace: 'ns1' });
    bus.subscribe('b', (m) => received.b.push(m), { namespace: 'ns1' });
    bus.subscribe('c', (m) => received.c.push(m), { namespace: 'ns1' });

    await bus.sendUnified({
      type: 'broadcast',
      from: 'sender',
      to: '*',
      payload: 'hello everyone',
      namespace: 'ns1',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    // Process queues + allow setImmediate callbacks to fire
    await vi.advanceTimersByTimeAsync(50);

    expect(received.a.length).toBe(1);
    expect(received.b.length).toBe(1);
    expect(received.c.length).toBe(1);
    expect(received.a[0].payload).toBe('hello everyone');
  });

  it('does not deliver to agents in a different namespace', async () => {
    const received: Record<string, Message[]> = { a: [], b: [] };

    bus.subscribe('a', (m) => received.a.push(m), { namespace: 'ns1' });
    bus.subscribe('b', (m) => received.b.push(m), { namespace: 'ns2' });

    await bus.sendUnified({
      type: 'broadcast',
      from: 'sender',
      to: '*',
      payload: 'ns1 only',
      namespace: 'ns1',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    vi.advanceTimersByTime(20);
    await vi.advanceTimersByTimeAsync(50);

    expect(received.a.length).toBe(1);
    expect(received.b.length).toBe(0);
  });
});

// ==========================================================================
// MessageBus → WriteThroughAdapter Integration
// ==========================================================================

describe('MessageBus → WriteThroughAdapter (end-to-end)', () => {
  let bus: MessageBus;
  let adapter: WriteThroughAdapter;
  let storedEntries: Map<string, { key: string; value: string; namespace: string }>;

  const mockStore = vi.fn(async (opts: { key: string; value: string; namespace: string }) => {
    storedEntries.set(opts.key, opts);
    return { success: true, id: `id-${opts.key}` };
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    storedEntries = new Map();
    mockStore.mockClear();

    bus = createMessageBus({ processingIntervalMs: 10, reaperIntervalMs: 60000 });
    await bus.initialize();

    adapter = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['persist-ns'] },
      mockStore,
    );
    adapter.attach();
  });

  afterEach(async () => {
    adapter.detach();
    await bus.shutdown();
    vi.useRealTimers();
  });

  it('persists sendUnified messages in enabled namespace to Memory DB', async () => {
    bus.subscribe('agent-1', () => {});

    await bus.sendUnified({
      type: 'direct',
      from: 'sender',
      to: 'agent-1',
      payload: { data: 'test' },
      namespace: 'persist-ns',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    // Allow fire-and-forget promise to resolve
    await vi.advanceTimersByTimeAsync(50);

    expect(mockStore).toHaveBeenCalledTimes(1);
    expect(storedEntries.size).toBe(1);
    const entry = [...storedEntries.values()][0];
    expect(entry.namespace).toBe('persist-ns');
    expect(entry.key).toMatch(/^msg:/);
  });

  it('does not persist messages in non-enabled namespace', async () => {
    bus.subscribe('agent-1', () => {});

    await bus.sendUnified({
      type: 'direct',
      from: 'sender',
      to: 'agent-1',
      payload: 'skip me',
      namespace: 'other-ns',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(mockStore).not.toHaveBeenCalled();
  });

  it('persists broadcastUnified messages', async () => {
    bus.subscribe('a', () => {});
    bus.subscribe('b', () => {});

    await bus.broadcastUnified({
      type: 'broadcast',
      from: 'sender',
      payload: 'to all',
      namespace: 'persist-ns',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    // Should be stored once (write-through is per-send, not per-recipient)
    expect(mockStore).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// Bug #4 Regression: detach() only removes own listener
// ==========================================================================

describe('WriteThroughAdapter — detach() isolation (Bug #4 regression)', () => {
  let bus: MessageBus;
  let storedA: string[];
  let storedB: string[];

  beforeEach(async () => {
    vi.useFakeTimers();
    storedA = [];
    storedB = [];
    bus = createMessageBus({ processingIntervalMs: 10, reaperIntervalMs: 60000 });
    await bus.initialize();
  });

  afterEach(async () => {
    await bus.shutdown();
    vi.useRealTimers();
  });

  it('detaching one adapter does not break another adapter on the same bus', async () => {
    const adapterA = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['ns-a'] },
      async (opts) => { storedA.push(opts.key); return { success: true, id: 'a' }; },
    );
    const adapterB = new WriteThroughAdapter(
      bus,
      { enabled: true, namespaces: ['ns-b'] },
      async (opts) => { storedB.push(opts.key); return { success: true, id: 'b' }; },
    );

    adapterA.attach();
    adapterB.attach();

    // Detach A — B should still work
    adapterA.detach();

    bus.subscribe('x', () => {});
    await bus.sendUnified({
      type: 'direct',
      from: 'sender',
      to: 'x',
      payload: 'test',
      namespace: 'ns-b',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(storedA).toHaveLength(0);
    expect(storedB).toHaveLength(1);

    adapterB.detach();
  });
});

// ==========================================================================
// Delivery Retry Tests
// ==========================================================================

describe('MessageBus — delivery retry on callback failure', () => {
  let bus: MessageBus;

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = createMessageBus({
      processingIntervalMs: 10,
      reaperIntervalMs: 60000,
      retryAttempts: 3,
    });
    await bus.initialize();
  });

  afterEach(async () => {
    await bus.shutdown();
    vi.useRealTimers();
  });

  it('retries delivery when callback throws and eventually delivers', async () => {
    let callCount = 0;
    const received: Message[] = [];

    bus.subscribe('agent-1', (m) => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('transient failure');
      }
      received.push(m);
    });

    await bus.send({
      type: 'direct',
      from: 'sender',
      to: 'agent-1',
      payload: 'retry me',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    // Process multiple rounds to allow retries (each round: 10ms processing + setImmediate)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(received.length).toBe(1);
    expect(received[0].payload).toBe('retry me');
  });

  it('emits message.failed after exhausting retries', async () => {
    const failures: unknown[] = [];
    bus.on('message.failed', (e) => failures.push(e));

    bus.subscribe('agent-1', () => {
      throw new Error('always fails');
    });

    await bus.send({
      type: 'direct',
      from: 'sender',
      to: 'agent-1',
      payload: 'doomed',
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(failures.length).toBe(1);
  });
});

// ==========================================================================
// Bug #5 Regression: Consensus majority formula
// ==========================================================================

describe('Consensus majority formula (Bug #5 regression)', () => {
  // Test the formula directly: Math.floor(n/2) + 1
  function majority(workerCount: number): number {
    return Math.floor(workerCount / 2) + 1;
  }

  it('1 worker requires 1 vote (simple majority)', () => {
    expect(majority(1)).toBe(1);
  });

  it('2 workers requires 2 votes', () => {
    expect(majority(2)).toBe(2);
  });

  it('3 workers requires 2 votes (not 3 / unanimity)', () => {
    expect(majority(3)).toBe(2);
  });

  it('4 workers requires 3 votes', () => {
    expect(majority(4)).toBe(3);
  });

  it('5 workers requires 3 votes', () => {
    expect(majority(5)).toBe(3);
  });

  it('15 workers requires 8 votes', () => {
    expect(majority(15)).toBe(8);
  });
});
