/**
 * Embeddings migration types — interfaces for the resumable batch-embed driver.
 *
 * The driver is a generic, pure function that walks a store's items,
 * re-embeds their source text through a replacement embedder, and writes
 * the new vectors back in batch-sized transactions with resume, rollback,
 * and abort support.
 *
 * @module cli/embeddings/migration
 */

/**
 * The schema version introduced by the neural-embeddings epic (#527).
 *
 * - Stores with `embeddings_version` unset or `< 2` need migration on open.
 * - A successful migration bumps the marker to exactly this value.
 * - Fresh stores created after this ships seed the marker to this value.
 */
export const EMBEDDINGS_VERSION = 2 as const;

/**
 * Canonical model label written into `memory_entries.embedding_model` by every
 * code path that produces a vector for moflo's memory.db — the bridge embedder
 * (`bridgeStoreEntry`), the migration store (`SqlJsMemoryEntriesStore` repair
 * mode), and the indexer (`bin/build-embeddings.mjs`). Centralized here so
 * `services/`, `memory/`, `embeddings/`, and `bin/` cannot drift; the
 * pre-#650 mix of `'Xenova/all-MiniLM-L6-v2'`, `'fastembed/all-MiniLM-L6-v2'`,
 * `'fast-all-MiniLM-L6-v2'`, `'local'`, and the retired hash-fallback model
 * tag (epic #527) was the exact failure mode #648 documented.
 */
export const CANONICAL_EMBEDDING_MODEL = 'fast-all-MiniLM-L6-v2';

/** Vector dimension every CANONICAL_EMBEDDING_MODEL embedder must produce. */
export const CANONICAL_EMBEDDING_DIMENSIONS = 384;

/**
 * A single item in a store that carries an embedding derived from source text.
 */
export interface MigrationItem {
  /** Stable row identifier. Used as the resume cursor. */
  id: string;

  /** The source text that produced the current embedding. Re-embedded as-is. */
  sourceText: string;
}

/**
 * A replacement embedding for a single row, produced by the new embedder.
 */
export interface MigrationBatchUpdate {
  id: string;
  embedding: Float32Array;
}

/**
 * Persisted resume cursor. One row per store, keyed by `storeId`.
 */
export interface MigrationCursor {
  storeId: string;
  /** `null` until the first batch commits successfully. */
  lastProcessedId: string | null;
  itemsDone: number;
  itemsTotal: number;
  startedAt: number;
  updatedAt: number;
}

/**
 * Progress event emitted once per committed batch (and on start/finish).
 */
export interface MigrationProgress {
  step:
    | 'start'
    | 'batch'
    | 'retry'
    | 'finish'
    | 'aborted';
  itemsDone: number;
  itemsTotal: number;
  /** Wall-clock time the last batch took to embed + commit. 0 on `start`. */
  batchMs: number;
  /** Populated on `retry` events only. */
  attempt?: number;
  /** Populated on `retry`/`aborted` when an error triggered the event. */
  error?: string;
}

/**
 * Final result of a `migrateStore` call.
 */
export interface MigrationResult {
  success: boolean;
  /** Total items re-embedded, including those from resumed runs. */
  itemsMigrated: number;
  itemsTotal: number;
  durationMs: number;
  /** True if the run picked up from a previously persisted cursor. */
  resumed: boolean;
  /** True if the caller-supplied `AbortSignal` fired. */
  aborted: boolean;
  /** True iff `embeddings_version` was bumped to `EMBEDDINGS_VERSION`. */
  versionBumped: boolean;
  errors: string[];
}

/**
 * Embedder adapter — a subset of `IEmbeddingService` the driver needs.
 *
 * The driver never touches caches or events: it just converts text → vectors.
 */
export interface MigrationEmbedder {
  /**
   * Embed a batch of texts. The returned array MUST be the same length and
   * order as the input. Each embedding MUST be a `Float32Array`.
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Store adapter — what a persistence layer (sql.js DB, in-memory fake, etc.)
 * must expose so the driver can migrate it.
 *
 * The driver issues calls in a strict pattern per batch:
 *   iterItems → beginTransaction → updateBatch → saveCursor → commit
 * On failure anywhere inside the transaction, `rollback` is called and the
 * batch is retried with backoff. All calls are serial.
 */
export interface MigrationStore {
  /** Stable ID used to scope the cursor row (e.g. `memory.db:memory_entries`). */
  readonly storeId: string;

  /** Count of items eligible for migration (non-empty `sourceText`). */
  countItems(): Promise<number>;

  /**
   * Return the next slice of items whose `id > afterId` (or all items when
   * `afterId` is `null`), ordered by `id` ascending, capped at `limit`.
   * Returning an empty array signals end-of-stream.
   */
  iterItems(afterId: string | null, limit: number): Promise<MigrationItem[]>;

  /**
   * Persist the new embeddings for the rows in this batch. Must be called
   * between `beginTransaction` and `commit`.
   */
  updateBatch(updates: readonly MigrationBatchUpdate[]): Promise<void>;

  /**
   * Persist the resume cursor. Must be called between `beginTransaction` and
   * `commit` so resuming lands on a consistent snapshot.
   */
  saveCursor(cursor: MigrationCursor): Promise<void>;

  /** Load the persisted cursor for this store, or `null` if no run is in flight. */
  loadCursor(): Promise<MigrationCursor | null>;

  /** Remove the cursor row (called after a successful full migration). */
  clearCursor(): Promise<void>;

  /** Read `embeddings_version`. Returns `null` when the marker is absent. */
  getVersion(): Promise<number | null>;

  /** Write `embeddings_version`. Only called once, after a fully successful run. */
  setVersion(version: number): Promise<void>;

  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Options accepted by `migrateStore`.
 */
export interface MigrateStoreOptions {
  store: MigrationStore;
  embedder: MigrationEmbedder;
  /** Items per batch. Defaults to `32`. */
  batchSize?: number;
  /** Max retries for a failing batch. Defaults to `3`. */
  maxRetries?: number;
  /** Base backoff delay in ms. Exponential: `base * 2^attempt`. Defaults to `50`. */
  backoffMs?: number;
  /** Progress callback invoked on `start`, each committed batch, and `finish`/`aborted`. */
  onProgress?: (progress: MigrationProgress) => void;
  /** Abort signal. When fired, the driver returns `aborted: true` at the next batch boundary. */
  signal?: AbortSignal;
}
