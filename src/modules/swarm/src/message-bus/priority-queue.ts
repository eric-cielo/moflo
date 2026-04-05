/**
 * Priority Message Queue using 5-Level Deques
 * O(1) insert, O(1) dequeue (vs O(n) for sorted array)
 */

import { Deque } from './deque.js';
import type { Message, MessagePriority } from '../types.js';

export interface MessageQueueEntry {
  message: Message;
  attempts: number;
  enqueuedAt: Date;
  lastAttemptAt?: Date;
}

const PRIORITY_ORDER: MessagePriority[] = ['critical', 'urgent', 'high', 'normal', 'low'];

export class PriorityMessageQueue {
  private queues: Map<MessagePriority, Deque<MessageQueueEntry>> = new Map();
  private totalCount: number = 0;

  constructor() {
    for (const priority of PRIORITY_ORDER) {
      this.queues.set(priority, new Deque<MessageQueueEntry>());
    }
  }

  get length(): number {
    return this.totalCount;
  }

  enqueue(entry: MessageQueueEntry): void {
    const priority = entry.message.priority;
    const queue = this.queues.get(priority)!;
    queue.pushBack(entry);
    this.totalCount++;
  }

  dequeue(): MessageQueueEntry | undefined {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        this.totalCount--;
        return queue.popFront();
      }
    }
    return undefined;
  }

  removeLowestPriority(): MessageQueueEntry | undefined {
    // Check from lowest priority upward
    for (const priority of [...PRIORITY_ORDER].reverse()) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        this.totalCount--;
        return queue.popFront();
      }
    }
    return undefined;
  }

  clear(): void {
    for (const queue of this.queues.values()) {
      queue.clear();
    }
    this.totalCount = 0;
  }

  find(predicate: (entry: MessageQueueEntry) => boolean): MessageQueueEntry | undefined {
    for (const queue of this.queues.values()) {
      const found = queue.find(predicate);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
}
