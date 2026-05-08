/**
 * Regression test for #1003 — drainPendingWrites must wait for writes that
 * are *about to be* queued (scheduled via setImmediate from a bus event)
 * and not just for writes that are already tracked at call time.
 *
 * Pre-fix symptom: doctor's hive-mind probe leaked 6 rows on Ubuntu CI
 * because the bus's `message.unified` handler hadn't yet fired by the time
 * `clearNamespace` snapshotted `pendingWrites`. Fast hosts won the race;
 * slow hosts hid the bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  WriteThroughAdapter,
  type MemoryStoreFunction,
  type MemoryDeleteFunction,
  type MemoryListFunction,
} from '../../swarm/message-bus/write-through-adapter.js';
import type { MessageBus } from '../../swarm/message-bus/message-bus.js';

class FakeBus extends EventEmitter {
  emitUnified(payload: Record<string, unknown>) {
    this.emit('message.unified', payload);
  }
}

function makeAdapter() {
  const stored: Array<{ key: string; namespace: string; value: string }> = [];
  const storeEntry: MemoryStoreFunction = vi.fn(async (opts) => {
    stored.push({ key: opts.key, namespace: opts.namespace, value: opts.value });
    return { success: true, id: opts.key };
  });
  const listEntries: MemoryListFunction = vi.fn(async ({ namespace }) => ({
    entries: stored
      .filter((s) => s.namespace === namespace)
      .map((s) => ({ key: s.key })),
  }));
  const deleteEntry: MemoryDeleteFunction = vi.fn(async ({ key, namespace }) => {
    const idx = stored.findIndex((s) => s.key === key && s.namespace === namespace);
    if (idx >= 0) stored.splice(idx, 1);
    return { success: true };
  });
  const bus = new FakeBus();
  const adapter = new WriteThroughAdapter(
    bus as unknown as MessageBus,
    { enabled: true, namespaces: ['hive-mind'] },
    storeEntry,
    { listEntries, deleteEntry },
  );
  adapter.attach();
  return { adapter, bus, stored, storeEntry, listEntries, deleteEntry };
}

describe('WriteThroughAdapter.drainPendingWrites — race fix (#1003)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('awaits writes scheduled by a bus event that fires immediately before drain', async () => {
    const { adapter, bus, stored } = makeAdapter();

    bus.emitUnified({
      messageId: 'm-1',
      namespace: 'hive-mind',
      type: 'broadcast',
      from: 'a',
      to: '*',
      payload: { x: 1 },
      priority: 'normal',
      ttlMs: 60_000,
    });

    await adapter.drainPendingWrites();

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: 'msg:m-1', namespace: 'hive-mind' });
  });

  it('clearNamespace removes writes that landed via a just-fired bus event', async () => {
    const { adapter, bus, stored, listEntries, deleteEntry } = makeAdapter();

    bus.emitUnified({
      messageId: 'racer',
      namespace: 'hive-mind',
      type: 'broadcast',
      from: 'a',
      to: '*',
      payload: {},
      priority: 'normal',
      ttlMs: 60_000,
    });

    await adapter.clearNamespace('hive-mind');

    expect(stored).toHaveLength(0);
    expect(listEntries).toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalled();
  });

  it('drainPendingWrites returns promptly when no writes are pending', async () => {
    const { adapter } = makeAdapter();
    const start = Date.now();
    await adapter.drainPendingWrites();
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('does not loop indefinitely when writes are continuously enqueued', async () => {
    const { adapter, bus } = makeAdapter();
    let i = 0;
    const interval = setInterval(() => {
      bus.emitUnified({
        messageId: `flood-${++i}`,
        namespace: 'hive-mind',
        type: 'broadcast',
        from: 'a',
        to: '*',
        payload: {},
        priority: 'normal',
        ttlMs: 60_000,
      });
    }, 1);

    try {
      await adapter.drainPendingWrites();
    } finally {
      clearInterval(interval);
    }
    // Drain returns within the 5-iteration cap even under continuous writes.
    expect(true).toBe(true);
  });

  it('drainPendingWrites works under fake timers (no setImmediate)', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, bus, stored } = makeAdapter();

      bus.emitUnified({
        messageId: 'fake-1',
        namespace: 'hive-mind',
        type: 'broadcast',
        from: 'a',
        to: '*',
        payload: {},
        priority: 'normal',
        ttlMs: 60_000,
      });

      await adapter.drainPendingWrites();
      expect(stored).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
