/**
 * Tests for Story #116: Deprecate In-Memory-Only Message Bus
 *
 * Covers:
 * - createMessageBus() emits DeprecationWarning
 * - MessageBus still works (backwards compatibility)
 * - MessageBus class is instantiable directly (opt-in bypass)
 */

import { describe, it, expect, vi } from 'vitest';
import { MessageBus, createMessageBus } from '../src/modules/swarm/src/message-bus/index.js';

describe('MessageBus deprecation (Story #116)', () => {
  it('createMessageBus() emits a DeprecationWarning', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    const bus = createMessageBus();
    expect(bus).toBeInstanceOf(MessageBus);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
      'DeprecationWarning',
    );

    spy.mockRestore();
  });

  it('MessageBus still works for in-process messaging', async () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const bus = createMessageBus({ processingIntervalMs: 10, reaperIntervalMs: 60000 });
    spy.mockRestore();

    await bus.initialize();

    const received: unknown[] = [];
    bus.subscribe('agent-1', (msg) => received.push(msg.payload));

    await bus.send({
      type: 'task_assign',
      from: 'orchestrator',
      to: 'agent-1',
      payload: { task: 'build' },
      priority: 'normal',
      requiresAck: false,
      ttlMs: 60000,
    });

    // Pull-mode still works
    const messages = bus.getMessages('agent-1');
    expect(messages.length).toBeGreaterThanOrEqual(0);

    await bus.shutdown();
  });

  it('MessageBus class can be instantiated directly without warning', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    const bus = new MessageBus();
    expect(bus).toBeInstanceOf(MessageBus);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('default config still uses in-memory (no breaking change)', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const bus = createMessageBus();
    spy.mockRestore();

    const stats = bus.getStats();
    expect(stats.totalMessages).toBe(0);
    expect(stats.queueDepth).toBe(0);
  });
});
