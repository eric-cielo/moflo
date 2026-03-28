/**
 * Message Bus — re-exports from decomposed module
 * @see ./message-bus/ for implementation
 */

export { MessageBus, createMessageBus, Deque, PriorityMessageQueue, WriteThroughAdapter, MessageStore } from './message-bus/index.js';
export type { MessageQueueEntry, WriteThroughConfig, MemoryStoreFunction, MemoryDeleteFunction, MemoryListFunction, MessageStoreConfig, MemoryListWithValueFunction, MemoryRetrieveFunction, EmbeddingFunction } from './message-bus/index.js';
