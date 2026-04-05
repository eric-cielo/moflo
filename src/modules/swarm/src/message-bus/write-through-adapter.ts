/**
 * Write-Through Adapter — MessageBus → Memory DB persistence
 *
 * Async fire-and-forget write to Memory DB for configured namespaces.
 * Delivery still happens through in-memory priority queues (no latency impact).
 *
 * Story #121: First consumer of write-through persistence for hive-mind.
 */

import type { MessageBus } from './message-bus.js';

/** Configuration for write-through persistence */
export interface WriteThroughConfig {
  /** Whether write-through is enabled globally */
  enabled: boolean;
  /** Namespaces to persist (messages in other namespaces are not written) */
  namespaces: string[];
}

/** Memory DB store function signature (injected to avoid hard dependency) */
export type MemoryStoreFunction = (options: {
  key: string;
  value: string;
  namespace: string;
  tags?: string[];
  ttl?: number;
  upsert?: boolean;
}) => Promise<{ success: boolean; id: string; error?: string }>;

/** Memory DB delete function signature */
export type MemoryDeleteFunction = (options: {
  key: string;
  namespace: string;
}) => Promise<{ success: boolean; error?: string }>;

/** Memory DB list function for reaper */
export type MemoryListFunction = (options: {
  namespace: string;
  limit?: number;
}) => Promise<{ entries: Array<{ key: string; metadata?: Record<string, unknown> }> }>;

/** Event payload from MessageBus `message.unified` */
interface UnifiedMessageEvent {
  messageId: string;
  namespace?: string;
  type: string;
  from: string;
  to: string | '*';
  payload: unknown;
  content?: string;
  priority: string;
  ttlMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * Attaches write-through persistence to a MessageBus instance.
 *
 * Listens for `message.unified` events (emitted after sendUnified/broadcastUnified)
 * and writes messages in enabled namespaces to Memory DB asynchronously.
 */
export class WriteThroughAdapter {
  private config: WriteThroughConfig;
  private storeEntry: MemoryStoreFunction;
  private deleteEntry?: MemoryDeleteFunction;
  private listEntries?: MemoryListFunction;
  private bus: MessageBus;
  private enabledNamespaces: Set<string>;
  private reaperInterval?: ReturnType<typeof setInterval>;
  private attached = false;
  private boundHandler?: (event: UnifiedMessageEvent) => void;
  private stats = { written: 0, errors: 0, reaped: 0 };

  constructor(
    bus: MessageBus,
    config: WriteThroughConfig,
    storeEntry: MemoryStoreFunction,
    options?: {
      deleteEntry?: MemoryDeleteFunction;
      listEntries?: MemoryListFunction;
    },
  ) {
    this.bus = bus;
    this.config = config;
    this.storeEntry = storeEntry;
    this.deleteEntry = options?.deleteEntry;
    this.listEntries = options?.listEntries;
    this.enabledNamespaces = new Set(config.namespaces);
  }

  /** Start listening for unified messages and writing through */
  attach(): void {
    if (!this.config.enabled || this.attached) return;
    this.attached = true;

    this.boundHandler = (event: UnifiedMessageEvent) => this.onUnifiedMessage(event);
    this.bus.on('message.unified', this.boundHandler);

    this.startDbReaper();
  }

  /** Stop listening and clean up */
  detach(): void {
    this.attached = false;
    if (this.boundHandler) {
      this.bus.removeListener('message.unified', this.boundHandler);
      this.boundHandler = undefined;
    }
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = undefined;
    }
  }

  /** Check if a namespace is configured for write-through */
  isNamespaceEnabled(namespace: string): boolean {
    return this.enabledNamespaces.has(namespace);
  }

  /** Add a namespace at runtime */
  enableNamespace(namespace: string): void {
    this.enabledNamespaces.add(namespace);
    this.config.namespaces = [...this.enabledNamespaces];
  }

  /** Remove a namespace at runtime */
  disableNamespace(namespace: string): void {
    this.enabledNamespaces.delete(namespace);
    this.config.namespaces = [...this.enabledNamespaces];
  }

  /** Get write-through statistics */
  getStats(): { written: number; errors: number; reaped: number } {
    return { ...this.stats };
  }

  /**
   * Clear all Memory DB entries for a namespace.
   * Used by hive-mind shutdown to clean persistent state.
   */
  async clearNamespace(namespace: string): Promise<void> {
    if (!this.listEntries || !this.deleteEntry) return;

    try {
      const result = await this.listEntries({ namespace, limit: 1000 });
      for (const entry of result.entries) {
        await this.deleteEntry({ key: entry.key, namespace });
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private onUnifiedMessage(event: UnifiedMessageEvent): void {
    if (!event.namespace || !this.enabledNamespaces.has(event.namespace)) {
      return;
    }

    const ttlSeconds = event.ttlMs ? Math.ceil(event.ttlMs / 1000) : undefined;

    // Fire-and-forget write to Memory DB
    this.storeEntry({
      key: `msg:${event.messageId}`,
      value: JSON.stringify({
        id: event.messageId,
        type: event.type,
        from: event.from,
        to: event.to,
        payload: event.payload,
        content: event.content,
        priority: event.priority,
        timestamp: Date.now(),
        metadata: event.metadata,
      }),
      namespace: event.namespace,
      tags: ['write-through', event.type],
      ttl: ttlSeconds,
      upsert: true,
    }).then(() => {
      this.stats.written++;
    }).catch(() => {
      this.stats.errors++;
    });
  }

  /**
   * DB reaper: cleans expired entries from Memory DB.
   * Runs every 120s (slower than in-memory reaper since DB is secondary).
   */
  private startDbReaper(): void {
    if (!this.listEntries || !this.deleteEntry) return;

    this.reaperInterval = setInterval(() => {
      this.reapExpiredDbEntries();
    }, 120_000);
  }

  private async reapExpiredDbEntries(): Promise<void> {
    if (!this.listEntries || !this.deleteEntry) return;

    for (const namespace of this.enabledNamespaces) {
      try {
        const result = await this.listEntries({ namespace, limit: 500 });
        const now = Date.now();

        for (const entry of result.entries) {
          const expiresAt = entry.metadata?.expiresAt as number | undefined;
          if (expiresAt && expiresAt < now) {
            await this.deleteEntry({ key: entry.key, namespace });
            this.stats.reaped++;
          }
        }
      } catch {
        // Best-effort reaper
      }
    }
  }
}
