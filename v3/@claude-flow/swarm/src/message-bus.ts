/**
 * V3 Message Bus
 * High-performance inter-agent communication system
 * Target: 1000+ messages/second throughput
 */

import { EventEmitter } from 'events';
import {
  Message,
  MessageAck,
  MessageBusConfig,
  MessageBusStats,
  MessageType,
  IMessageBus,
  SWARM_CONSTANTS,
} from './types.js';

interface MessageQueueEntry {
  message: Message;
  attempts: number;
  enqueuedAt: Date;
  lastAttemptAt?: Date;
}

interface Subscription {
  agentId: string;
  callback: (message: Message) => void;
  filter?: MessageType[];
}

export class MessageBus extends EventEmitter implements IMessageBus {
  private config: MessageBusConfig;
  private queues: Map<string, MessageQueueEntry[]> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private pendingAcks: Map<string, { message: Message; timeout: NodeJS.Timeout }> = new Map();
  private processingInterval?: NodeJS.Timeout;
  private statsInterval?: NodeJS.Timeout;
  private messageCounter: number = 0;
  private stats: MessageBusStats;
  private startTime: Date = new Date();
  // Circular buffer for message history (max 60 entries for 60 seconds)
  private messageHistory: { timestamp: number; count: number }[] = [];
  private messageHistoryIndex: number = 0;
  private static readonly MAX_HISTORY_SIZE = 60;

  constructor(config: Partial<MessageBusConfig> = {}) {
    super();
    this.config = {
      maxQueueSize: config.maxQueueSize ?? SWARM_CONSTANTS.MAX_QUEUE_SIZE,
      processingIntervalMs: config.processingIntervalMs ?? 10,
      ackTimeoutMs: config.ackTimeoutMs ?? 5000,
      retryAttempts: config.retryAttempts ?? SWARM_CONSTANTS.MAX_RETRIES,
      enablePersistence: config.enablePersistence ?? false,
      compressionEnabled: config.compressionEnabled ?? false,
    };

    this.stats = {
      totalMessages: 0,
      messagesPerSecond: 0,
      avgLatencyMs: 0,
      queueDepth: 0,
      ackRate: 1.0,
      errorRate: 0,
    };
  }

  async initialize(config?: MessageBusConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    this.startProcessing();
    this.startStatsCollection();
    this.emit('initialized');
  }

  async shutdown(): Promise<void> {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }

    // Clear all pending acks
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout);
    }
    this.pendingAcks.clear();

    // Clear all queues
    this.queues.clear();
    this.subscriptions.clear();
    this.messageHistory = [];

    this.emit('shutdown');
  }

  private generateMessageId(): string {
    this.messageCounter++;
    return `msg_${Date.now()}_${this.messageCounter.toString(36)}`;
  }

  async send(message: Omit<Message, 'id' | 'timestamp'>): Promise<string> {
    const fullMessage: Message = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date(),
    };

    return this.enqueue(fullMessage);
  }

  async broadcast(message: Omit<Message, 'id' | 'timestamp' | 'to'>): Promise<string> {
    const fullMessage: Message = {
      ...message,
      id: this.generateMessageId(),
      timestamp: new Date(),
      to: 'broadcast',
    };

    return this.enqueue(fullMessage);
  }

  private async enqueue(message: Message): Promise<string> {
    const startTime = performance.now();

    if (message.to === 'broadcast') {
      // Broadcast to all subscribed agents
      for (const [agentId, subscription] of this.subscriptions) {
        if (agentId !== message.from) {
          this.addToQueue(agentId, message);
        }
      }
    } else {
      this.addToQueue(message.to, message);
    }

    this.stats.totalMessages++;
    const latency = performance.now() - startTime;
    this.updateLatencyStats(latency);

    this.emit('message.enqueued', { messageId: message.id, to: message.to });

    return message.id;
  }

  private addToQueue(agentId: string, message: Message): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }

    const queue = this.queues.get(agentId)!;

    // Check queue size limit
    if (queue.length >= this.config.maxQueueSize) {
      // Drop oldest low-priority messages
      const lowPriorityIdx = queue.findIndex(e =>
        e.message.priority === 'low' || e.message.priority === 'normal'
      );
      if (lowPriorityIdx !== -1) {
        queue.splice(lowPriorityIdx, 1);
      } else {
        // Queue full with high priority messages, drop oldest
        queue.shift();
      }
    }

    // Insert by priority (urgent first)
    const priorityOrder: Record<Message['priority'], number> = {
      urgent: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    const insertIdx = queue.findIndex(
      e => priorityOrder[e.message.priority] > priorityOrder[message.priority]
    );

    const entry: MessageQueueEntry = {
      message,
      attempts: 0,
      enqueuedAt: new Date(),
    };

    if (insertIdx === -1) {
      queue.push(entry);
    } else {
      queue.splice(insertIdx, 0, entry);
    }
  }

  subscribe(agentId: string, callback: (message: Message) => void, filter?: MessageType[]): void {
    this.subscriptions.set(agentId, {
      agentId,
      callback,
      filter,
    });

    // Initialize queue for this agent
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }

    this.emit('subscription.added', { agentId });
  }

  unsubscribe(agentId: string): void {
    this.subscriptions.delete(agentId);
    this.queues.delete(agentId);
    this.emit('subscription.removed', { agentId });
  }

  async acknowledge(ack: MessageAck): Promise<void> {
    const pending = this.pendingAcks.get(ack.messageId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingAcks.delete(ack.messageId);

    if (!ack.received && ack.error) {
      this.handleAckFailure(pending.message, ack.error);
    }

    this.emit('message.acknowledged', {
      messageId: ack.messageId,
      success: ack.received
    });
  }

  private startProcessing(): void {
    this.processingInterval = setInterval(() => {
      this.processQueues();
    }, this.config.processingIntervalMs);
  }

  private processQueues(): void {
    const now = Date.now();

    for (const [agentId, queue] of this.queues) {
      const subscription = this.subscriptions.get(agentId);
      if (!subscription) {
        continue;
      }

      // Process messages in batch for better throughput
      const batchSize = Math.min(10, queue.length);
      const batch: MessageQueueEntry[] = [];

      for (let i = 0; i < batchSize && queue.length > 0; i++) {
        const entry = queue.shift()!;

        // Check TTL
        if (now - entry.message.timestamp.getTime() > entry.message.ttlMs) {
          this.emit('message.expired', { messageId: entry.message.id });
          continue;
        }

        // Check filter
        if (subscription.filter && !subscription.filter.includes(entry.message.type)) {
          continue;
        }

        batch.push(entry);
      }

      // Deliver batch
      for (const entry of batch) {
        this.deliverMessage(subscription, entry);
      }
    }
  }

  private deliverMessage(subscription: Subscription, entry: MessageQueueEntry): void {
    const message = entry.message;

    try {
      // Set up ack timeout if required
      if (message.requiresAck) {
        const timeout = setTimeout(() => {
          this.handleAckTimeout(message);
        }, this.config.ackTimeoutMs);

        this.pendingAcks.set(message.id, { message, timeout });
      }

      // Deliver asynchronously
      setImmediate(() => {
        try {
          subscription.callback(message);
          this.emit('message.delivered', {
            messageId: message.id,
            to: subscription.agentId
          });
        } catch (error) {
          this.handleDeliveryError(message, entry, error as Error);
        }
      });
    } catch (error) {
      this.handleDeliveryError(message, entry, error as Error);
    }
  }

  private handleAckTimeout(message: Message): void {
    this.pendingAcks.delete(message.id);
    this.stats.ackRate = Math.max(0, this.stats.ackRate - 0.01);
    this.emit('message.ack_timeout', { messageId: message.id });
  }

  private handleAckFailure(message: Message, error: string): void {
    this.stats.errorRate += 0.01;
    this.emit('message.ack_failed', { messageId: message.id, error });
  }

  private handleDeliveryError(message: Message, entry: MessageQueueEntry, error: Error): void {
    entry.attempts++;
    entry.lastAttemptAt = new Date();

    if (entry.attempts < this.config.retryAttempts) {
      // Re-queue for retry
      this.addToQueue(message.to, message);
      this.emit('message.retry', {
        messageId: message.id,
        attempt: entry.attempts
      });
    } else {
      this.stats.errorRate += 0.01;
      this.emit('message.failed', {
        messageId: message.id,
        error: error.message
      });
    }
  }

  private startStatsCollection(): void {
    this.statsInterval = setInterval(() => {
      this.calculateMessagesPerSecond();
    }, 1000);
  }

  private calculateMessagesPerSecond(): void {
    const now = Date.now();
    const entry = { timestamp: now, count: this.stats.totalMessages };

    // Use circular buffer pattern - O(1) instead of O(n) filter
    if (this.messageHistory.length < MessageBus.MAX_HISTORY_SIZE) {
      this.messageHistory.push(entry);
    } else {
      this.messageHistory[this.messageHistoryIndex] = entry;
      this.messageHistoryIndex = (this.messageHistoryIndex + 1) % MessageBus.MAX_HISTORY_SIZE;
    }

    // Calculate messages per second from history
    if (this.messageHistory.length >= 2) {
      // Find oldest valid entry (within last 60 seconds)
      let oldest = entry;
      for (const h of this.messageHistory) {
        if (h.timestamp < oldest.timestamp && now - h.timestamp < 60000) {
          oldest = h;
        }
      }
      const seconds = (now - oldest.timestamp) / 1000;
      const messages = entry.count - oldest.count;
      this.stats.messagesPerSecond = seconds > 0 ? messages / seconds : 0;
    }

    // Update queue depth
    this.stats.queueDepth = this.getQueueDepth();
  }

  private updateLatencyStats(latencyMs: number): void {
    // Exponential moving average
    const alpha = 0.1;
    this.stats.avgLatencyMs = alpha * latencyMs + (1 - alpha) * this.stats.avgLatencyMs;
  }

  getStats(): MessageBusStats {
    return { ...this.stats };
  }

  getQueueDepth(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  // Direct message retrieval for agents (pull mode)
  getMessages(agentId: string): Message[] {
    const queue = this.queues.get(agentId);
    if (!queue) {
      return [];
    }

    const now = Date.now();
    const messages: Message[] = [];

    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (now - entry.message.timestamp.getTime() <= entry.message.ttlMs) {
        messages.push(entry.message);
      }
    }

    return messages;
  }

  // Query pending messages for an agent
  hasPendingMessages(agentId: string): boolean {
    const queue = this.queues.get(agentId);
    return queue !== undefined && queue.length > 0;
  }

  // Get message by ID
  getMessage(messageId: string): Message | undefined {
    for (const queue of this.queues.values()) {
      const entry = queue.find(e => e.message.id === messageId);
      if (entry) {
        return entry.message;
      }
    }
    return undefined;
  }
}

export function createMessageBus(config?: Partial<MessageBusConfig>): MessageBus {
  return new MessageBus(config);
}
