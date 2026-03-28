/**
 * Message Bus — re-exports from decomposed module
 * @see ./message-bus/ for implementation
 */

export { MessageBus, createMessageBus, Deque, PriorityMessageQueue } from './message-bus/index.js';
export type { MessageQueueEntry } from './message-bus/index.js';
