/**
 * Message Bus Module
 *
 * Decomposed into:
 * - deque.ts: High-performance circular buffer deque
 * - priority-queue.ts: 5-level priority message queue
 * - message-bus.ts: Unified message broker (push + pull delivery)
 */

export { Deque } from './deque.js';
export { PriorityMessageQueue, type MessageQueueEntry } from './priority-queue.js';
export { MessageBus } from './message-bus.js';
export { WriteThroughAdapter, type WriteThroughConfig, type MemoryStoreFunction, type MemoryDeleteFunction, type MemoryListFunction } from './write-through-adapter.js';
export { MessageStore, type MessageStoreConfig, type MemoryListWithValueFunction, type MemoryRetrieveFunction, type EmbeddingFunction } from './message-store.js';

import type { MessageBusConfig } from '../types.js';
import { MessageBus } from './message-bus.js';

/**
 * @deprecated Use MessageStore for persistent cross-process messaging.
 * MessageBus is kept as an in-process fallback for high-throughput scenarios.
 */
export function createMessageBus(config?: Partial<MessageBusConfig>): MessageBus {
  if (typeof process !== 'undefined' && process.emitWarning) {
    process.emitWarning(
      'createMessageBus() is deprecated. Use MessageStore for persistent cross-process messaging.',
      'DeprecationWarning',
    );
  }
  return new MessageBus(config);
}
