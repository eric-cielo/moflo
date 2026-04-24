/**
 * In-memory reference `MigrationStore` — the test fixture for the driver.
 *
 * Backed by plain maps, with optional per-call failure injection so unit
 * tests can exercise rollback and retry without wiring up sql.js. New
 * adapters can mirror this shape when they land.
 *
 * @module @moflo/embeddings/migration/in-memory-store
 */

import type {
  MigrationBatchUpdate,
  MigrationCursor,
  MigrationItem,
  MigrationStore,
} from './types.js';

export interface InMemoryItem {
  id: string;
  sourceText: string;
  embedding?: Float32Array;
}

export interface InMemoryStoreOptions {
  storeId: string;
  items: InMemoryItem[];
  initialVersion?: number | null;
}

/**
 * Injection points: each hook returns `void` to pass and `throws` to fail.
 * `trip` set to a positive number counts down and throws at 0, allowing
 * precise control over which attempt fails inside a retry loop.
 */
export interface FailureInjector {
  beforeEmbed?: () => void;
  beforeUpdate?: () => void;
  beforeCommit?: () => void;
  beforeRollback?: () => void;
  /** `null` = abort only at the next batch boundary (async check). */
  abortAt?: number | null;
}

export class InMemoryMigrationStore implements MigrationStore {
  readonly storeId: string;

  private items: InMemoryItem[];
  private version: number | null;
  private cursor: MigrationCursor | null = null;

  // Transaction shadow state — mutations are staged here until commit.
  private inTx = false;
  private txUpdates: MigrationBatchUpdate[] = [];
  private txCursor: MigrationCursor | null = null;
  private txCursorStaged = false;

  // Stats exposed for assertions.
  public stats = {
    beginTransaction: 0,
    commit: 0,
    rollback: 0,
    updateBatchCalls: 0,
    saveCursorCalls: 0,
    embedCallArgs: [] as string[][],
  };

  public injector: FailureInjector = {};

  constructor(opts: InMemoryStoreOptions) {
    this.storeId = opts.storeId;
    // Keep a sorted-by-id snapshot so `iterItems` is deterministic.
    this.items = [...opts.items].sort((a, b) => compareIds(a.id, b.id));
    this.version = opts.initialVersion ?? null;
  }

  async countItems(): Promise<number> {
    return this.items.filter((i) => i.sourceText.length > 0).length;
  }

  async iterItems(afterId: string | null, limit: number): Promise<MigrationItem[]> {
    const startIndex = afterId === null ? 0 : indexAfter(this.items, afterId);
    const out: MigrationItem[] = [];
    for (let i = startIndex; i < this.items.length && out.length < limit; i++) {
      const item = this.items[i]!;
      if (item.sourceText.length === 0) continue;
      out.push({ id: item.id, sourceText: item.sourceText });
    }
    return out;
  }

  async updateBatch(updates: readonly MigrationBatchUpdate[]): Promise<void> {
    this.stats.updateBatchCalls++;
    this.assertInTx('updateBatch');
    this.injector.beforeUpdate?.();
    // Stage — do not touch `items` until commit.
    this.txUpdates.push(...updates);
  }

  async saveCursor(cursor: MigrationCursor): Promise<void> {
    this.stats.saveCursorCalls++;
    this.assertInTx('saveCursor');
    this.txCursor = { ...cursor };
    this.txCursorStaged = true;
  }

  async loadCursor(): Promise<MigrationCursor | null> {
    return this.cursor ? { ...this.cursor } : null;
  }

  async clearCursor(): Promise<void> {
    this.cursor = null;
  }

  async getVersion(): Promise<number | null> {
    return this.version;
  }

  async setVersion(version: number): Promise<void> {
    this.version = version;
  }

  async beginTransaction(): Promise<void> {
    if (this.inTx) {
      throw new Error(
        `[${this.storeId}] beginTransaction called while already in transaction`,
      );
    }
    this.stats.beginTransaction++;
    this.inTx = true;
    this.resetTxState();
  }

  async commit(): Promise<void> {
    this.assertInTx('commit');
    this.injector.beforeCommit?.();
    // Apply staged updates atomically.
    for (const update of this.txUpdates) {
      const idx = this.items.findIndex((item) => item.id === update.id);
      if (idx === -1) {
        throw new Error(`[${this.storeId}] commit: no item with id=${update.id}`);
      }
      this.items[idx] = { ...this.items[idx]!, embedding: update.embedding };
    }
    if (this.txCursorStaged) {
      this.cursor = this.txCursor;
    }
    this.stats.commit++;
    this.inTx = false;
    this.resetTxState();
  }

  async rollback(): Promise<void> {
    this.assertInTx('rollback');
    this.injector.beforeRollback?.();
    this.stats.rollback++;
    this.inTx = false;
    this.resetTxState();
  }

  private resetTxState(): void {
    this.txUpdates = [];
    this.txCursor = null;
    this.txCursorStaged = false;
  }

  snapshot(): ReadonlyArray<InMemoryItem> {
    return this.items.map((i) => ({ ...i, embedding: i.embedding?.slice() }));
  }

  getCursor(): MigrationCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  getVersionSync(): number | null {
    return this.version;
  }

  private assertInTx(op: string): void {
    if (!this.inTx) {
      throw new Error(`[${this.storeId}] ${op} called outside of a transaction`);
    }
  }
}

function indexAfter(items: InMemoryItem[], afterId: string): number {
  // Linear scan is plenty for tests and reference use.
  for (let i = 0; i < items.length; i++) {
    if (compareIds(items[i]!.id, afterId) > 0) return i;
  }
  return items.length;
}

function compareIds(a: string, b: string): number {
  // Natural string compare — consumers should use sortable IDs (UUIDv7, ULID, etc.).
  return a < b ? -1 : a > b ? 1 : 0;
}
