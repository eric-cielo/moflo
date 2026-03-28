/**
 * V3 Message Bus — Unified inter-agent communication broker
 * Push + pull delivery, namespace isolation, TTL reaper (60s sweep)
 */

import { EventEmitter } from 'events';
import {
  Message,
  UnifiedMessage,
  MessageAck,
  MessageBusConfig,
  MessageBusStats,
  MessageType,
  MessageFilter,
  IMessageBus,
  SWARM_CONSTANTS,
} from '../types.js';
import { PriorityMessageQueue, type MessageQueueEntry } from './priority-queue.js';

interface Subscription {
  agentId: string;
  callback: (message: Message) => void;
  filter?: MessageType[];
  namespace?: string;
}

/**
 * @deprecated Use MessageStore for persistent cross-process messaging.
 * MessageBus remains available as an in-process optimization for high-throughput
 * scenarios (1000+ msg/s) where persistence is not needed.
 *
 * Migration: Replace `createMessageBus()` with `new MessageStore(config)`.
 * See Story #111 for MessageStore API.
 */
export class MessageBus extends EventEmitter implements IMessageBus {
  private config: MessageBusConfig;
  private queues: Map<string, PriorityMessageQueue> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private pendingAcks: Map<string, { message: Message; timeout: NodeJS.Timeout }> = new Map();
  private processingInterval?: NodeJS.Timeout;
  private statsInterval?: NodeJS.Timeout;
  private reaperInterval?: NodeJS.Timeout;
  private messageCounter: number = 0;
  private stats: MessageBusStats;
  private messageHistory: { timestamp: number; count: number }[] = [];
  private messageHistoryIndex: number = 0;
  private static readonly MAX_HISTORY_SIZE = 60;
  private namespaceMessages: Map<string, Set<string>> = new Map();
  private messageMetadata: Map<string, { namespace?: string; content?: string; metadata?: Record<string, unknown> }> = new Map();
  /** Reference count for broadcast messages: how many queues still hold this message */
  private messageRefCount: Map<string, number> = new Map();

  constructor(config: Partial<MessageBusConfig> = {}) {
    super();
    this.config = {
      maxQueueSize: config.maxQueueSize ?? SWARM_CONSTANTS.MAX_QUEUE_SIZE,
      processingIntervalMs: config.processingIntervalMs ?? 10,
      ackTimeoutMs: config.ackTimeoutMs ?? 5000,
      retryAttempts: config.retryAttempts ?? SWARM_CONSTANTS.MAX_RETRIES,
      enablePersistence: config.enablePersistence ?? false,
      compressionEnabled: config.compressionEnabled ?? false,
      reaperIntervalMs: config.reaperIntervalMs ?? 60000,
    };

    this.stats = {
      totalMessages: 0,
      messagesPerSecond: 0,
      avgLatencyMs: 0,
      queueDepth: 0,
      ackRate: 1.0,
      errorRate: 0,
      totalReaped: 0,
      activeNamespaces: 0,
    };
  }

  async initialize(config?: MessageBusConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.startProcessing();
    this.startStatsCollection();
    this.startReaper();
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
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = undefined;
    }
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout);
    }
    this.pendingAcks.clear();
    this.queues.clear();
    this.subscriptions.clear();
    this.messageHistory = [];
    this.namespaceMessages.clear();
    this.messageMetadata.clear();
    this.messageRefCount.clear();
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
      let recipientCount = 0;
      for (const [agentId] of this.subscriptions) {
        if (agentId !== message.from) {
          this.addToQueue(agentId, message);
          recipientCount++;
        }
      }
      if (recipientCount > 1) {
        this.messageRefCount.set(message.id, recipientCount);
      }
    } else {
      this.addToQueue(message.to, message);
    }

    this.stats.totalMessages++;
    this.updateLatencyStats(performance.now() - startTime);
    this.emit('message.enqueued', { messageId: message.id, to: message.to });
    return message.id;
  }

  private addToQueue(agentId: string, message: Message): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, new PriorityMessageQueue());
    }
    const queue = this.queues.get(agentId)!;
    if (queue.length >= this.config.maxQueueSize) {
      queue.removeLowestPriority();
    }
    queue.enqueue({ message, attempts: 0, enqueuedAt: new Date() });
  }

  async sendUnified(message: Omit<UnifiedMessage, 'id' | 'timestamp'>): Promise<string> {
    const { namespace } = message;

    const legacyMessage: Omit<Message, 'id' | 'timestamp'> = {
      type: message.type,
      from: message.from,
      to: message.to === '*' ? 'broadcast' : message.to,
      payload: message.payload ?? message.content,
      priority: message.priority === 'critical' ? 'urgent' : message.priority,
      requiresAck: message.requiresAck,
      ttlMs: message.ttlMs,
      correlationId: message.correlationId,
    };

    const id = await this.send(legacyMessage);

    this.messageMetadata.set(id, {
      namespace,
      content: message.content,
      metadata: message.metadata,
    });

    if (namespace) {
      if (!this.namespaceMessages.has(namespace)) {
        this.namespaceMessages.set(namespace, new Set());
      }
      this.namespaceMessages.get(namespace)!.add(id);
    }

    // Emit after metadata is set so write-through adapters have full context
    this.emit('message.unified', {
      messageId: id,
      namespace,
      type: message.type,
      from: message.from,
      to: message.to,
      payload: message.payload ?? message.content,
      content: message.content,
      priority: message.priority,
      ttlMs: message.ttlMs,
      metadata: message.metadata,
    });

    return id;
  }

  async broadcastUnified(message: Omit<UnifiedMessage, 'id' | 'timestamp' | 'to'>): Promise<string> {
    return this.sendUnified({ ...message, to: '*' });
  }

  subscribe(agentId: string, callback: (message: Message) => void, options?: MessageType[] | { filter?: MessageType[]; namespace?: string }): void {
    const filter = Array.isArray(options) ? options : options?.filter;
    const namespace = Array.isArray(options) ? undefined : options?.namespace;

    this.subscriptions.set(agentId, { agentId, callback, filter, namespace });

    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, new PriorityMessageQueue());
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
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingAcks.delete(ack.messageId);

    if (!ack.received && ack.error) {
      this.stats.errorRate += 0.01;
      this.emit('message.ack_failed', { messageId: ack.messageId, error: ack.error });
    }
    this.emit('message.acknowledged', { messageId: ack.messageId, success: ack.received });
  }

  getMessages(agentId: string, filter?: MessageFilter): Message[] {
    const queue = this.queues.get(agentId);
    if (!queue) return [];

    const now = Date.now();
    const messages: Message[] = [];
    const remaining: MessageQueueEntry[] = [];

    const limit = filter?.limit;

    while (queue.length > 0) {
      const entry = queue.dequeue();
      if (!entry) break;

      if (now - entry.message.timestamp.getTime() > entry.message.ttlMs) {
        this.cleanupMessageMetadata(entry.message.id);
        continue;
      }

      if (this.matchesFilter(entry.message, filter)) {
        messages.push(entry.message);
        if (limit && messages.length >= limit) {
          break;
        }
      } else {
        remaining.push(entry);
      }
    }

    for (const entry of remaining) {
      queue.enqueue(entry);
    }

    return messages;
  }

  private matchesFilter(message: Message, filter?: MessageFilter): boolean {
    if (!filter) return true;
    if (filter.from && message.from !== filter.from) return false;
    if (filter.type && message.type !== filter.type) return false;
    if (filter.since !== undefined && message.timestamp.getTime() <= filter.since) return false;
    if (filter.namespace) {
      const meta = this.messageMetadata.get(message.id);
      if (!meta?.namespace || meta.namespace !== filter.namespace) return false;
    }
    return true;
  }

  hasPendingMessages(agentId: string): boolean {
    const queue = this.queues.get(agentId);
    return queue !== undefined && queue.length > 0;
  }

  getMessage(messageId: string): Message | undefined {
    for (const queue of this.queues.values()) {
      const entry = queue.find(e => e.message.id === messageId);
      if (entry) return entry.message;
    }
    return undefined;
  }

  getStats(): MessageBusStats {
    this.stats.activeNamespaces = this.namespaceMessages.size;
    return { ...this.stats };
  }

  getQueueDepth(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
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
      if (!subscription) continue;

      const batchSize = Math.min(10, queue.length);
      const batch: MessageQueueEntry[] = [];
      const skipped: MessageQueueEntry[] = [];

      for (let i = 0; i < batchSize && queue.length > 0; i++) {
        const entry = queue.dequeue();
        if (!entry) break;

        if (now - entry.message.timestamp.getTime() > entry.message.ttlMs) {
          this.cleanupMessageMetadata(entry.message.id);
          this.emit('message.expired', { messageId: entry.message.id });
          continue;
        }

        if (subscription.filter && !subscription.filter.includes(entry.message.type)) {
          skipped.push(entry);
          continue;
        }

        if (subscription.namespace) {
          const msgMeta = this.messageMetadata.get(entry.message.id);
          if (!msgMeta?.namespace || msgMeta.namespace !== subscription.namespace) {
            skipped.push(entry);
            continue;
          }
        }

        batch.push(entry);
      }

      // Re-enqueue messages that didn't match this subscription's filter
      for (const entry of skipped) {
        queue.enqueue(entry);
      }

      for (const entry of batch) {
        this.deliverMessage(subscription, entry);
      }
    }
  }

  private deliverMessage(subscription: Subscription, entry: MessageQueueEntry): void {
    const { message } = entry;

    try {
      if (message.requiresAck) {
        const timeout = setTimeout(() => {
          this.pendingAcks.delete(message.id);
          this.stats.ackRate = Math.max(0, this.stats.ackRate - 0.01);
          this.emit('message.ack_timeout', { messageId: message.id });
        }, this.config.ackTimeoutMs);
        this.pendingAcks.set(message.id, { message, timeout });
      }

      setImmediate(() => {
        try {
          subscription.callback(message);
          this.decrementAndCleanup(message.id);
          this.emit('message.delivered', { messageId: message.id, to: subscription.agentId });
        } catch (error) {
          this.handleDeliveryError(message, entry, error as Error);
        }
      });
    } catch (error) {
      this.handleDeliveryError(message, entry, error as Error);
    }
  }

  private handleDeliveryError(message: Message, entry: MessageQueueEntry, error: Error): void {
    entry.attempts++;
    entry.lastAttemptAt = new Date();

    if (entry.attempts < this.config.retryAttempts) {
      // Re-enqueue the same entry (preserving attempt count) instead of creating a new one
      if (!this.queues.has(message.to)) {
        this.queues.set(message.to, new PriorityMessageQueue());
      }
      this.queues.get(message.to)!.enqueue(entry);
      this.emit('message.retry', { messageId: message.id, attempt: entry.attempts });
    } else {
      this.stats.errorRate += 0.01;
      this.emit('message.failed', { messageId: message.id, error: error.message });
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

    if (this.messageHistory.length < MessageBus.MAX_HISTORY_SIZE) {
      this.messageHistory.push(entry);
    } else {
      this.messageHistory[this.messageHistoryIndex] = entry;
      this.messageHistoryIndex = (this.messageHistoryIndex + 1) % MessageBus.MAX_HISTORY_SIZE;
    }

    if (this.messageHistory.length >= 2) {
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

    this.stats.queueDepth = this.getQueueDepth();
  }

  private updateLatencyStats(latencyMs: number): void {
    const alpha = 0.1;
    this.stats.avgLatencyMs = alpha * latencyMs + (1 - alpha) * this.stats.avgLatencyMs;
  }

  private startReaper(): void {
    this.reaperInterval = setInterval(() => {
      this.reapExpiredMessages();
    }, this.config.reaperIntervalMs);
  }

  private reapExpiredMessages(): void {
    const now = Date.now();
    let reaped = 0;

    for (const [, queue] of this.queues) {
      const surviving: MessageQueueEntry[] = [];

      while (queue.length > 0) {
        const entry = queue.dequeue();
        if (!entry) break;

        if (now - entry.message.timestamp.getTime() > entry.message.ttlMs) {
          reaped++;
          this.messageRefCount.delete(entry.message.id);
          this.cleanupMessageMetadata(entry.message.id);
        } else {
          surviving.push(entry);
        }
      }

      for (const entry of surviving) {
        queue.enqueue(entry);
      }
    }

    if (reaped > 0) {
      this.stats.totalReaped += reaped;
      this.emit('message.reaped', { count: reaped });
    }
  }

  /**
   * Decrement broadcast ref count; only clean metadata when all recipients have received.
   * For non-broadcast (ref count absent), cleans immediately.
   */
  private decrementAndCleanup(messageId: string): void {
    const refs = this.messageRefCount.get(messageId);
    if (refs !== undefined) {
      if (refs <= 1) {
        this.messageRefCount.delete(messageId);
        this.cleanupMessageMetadata(messageId);
      } else {
        this.messageRefCount.set(messageId, refs - 1);
      }
    } else {
      this.cleanupMessageMetadata(messageId);
    }
  }

  private cleanupMessageMetadata(messageId: string): void {
    const meta = this.messageMetadata.get(messageId);
    if (meta?.namespace) {
      const nsSet = this.namespaceMessages.get(meta.namespace);
      if (nsSet) {
        nsSet.delete(messageId);
        if (nsSet.size === 0) {
          this.namespaceMessages.delete(meta.namespace);
        }
      }
    }
    this.messageMetadata.delete(messageId);
  }
}
