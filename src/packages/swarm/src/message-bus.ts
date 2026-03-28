/**
 * Message Bus — re-exports from decomposed module
 * @see ./message-bus/ for implementation
 */

export { MessageBus, createMessageBus, Deque, PriorityMessageQueue, WriteThroughAdapter } from './message-bus/index.js';
export type { MessageQueueEntry, WriteThroughConfig, MemoryStoreFunction, MemoryDeleteFunction, MemoryListFunction } from './message-bus/index.js';
