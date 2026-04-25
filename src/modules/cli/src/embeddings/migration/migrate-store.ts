/**
 * Resumable, transactional batch-embed migration driver.
 *
 * Walks every eligible row in a store, re-embeds its `sourceText` through
 * the supplied embedder, writes new vectors back in batch transactions, and
 * bumps the store's `embeddings_version` marker to {@link EMBEDDINGS_VERSION}
 * only once the final batch commits.
 *
 * Semantics:
 *   - Resumable: persists a cursor per store; a second call with the same
 *     arguments after an abort picks up exactly where the previous call left
 *     off and yields the same end state.
 *   - Transactional per batch: `beginTransaction` → `updateBatch` +
 *     `saveCursor` → `commit`. On any error inside the critical section the
 *     driver calls `rollback` and retries the batch up to `maxRetries` times
 *     with exponential backoff.
 *   - Abort-safe: the signal is checked at batch boundaries. When fired, the
 *     driver flushes the in-flight batch (if any), persists the cursor, and
 *     returns `aborted: true` — it never leaves a half-written batch.
 *   - One-shot version bump: `setVersion(EMBEDDINGS_VERSION)` runs only after
 *     the last batch commits; interrupted runs leave the old version (or
 *     `null`) intact so the next open re-triggers migration.
 *
 * @module cli/embeddings/migration/migrate-store
 */

import {
  EMBEDDINGS_VERSION,
  type MigrateStoreOptions,
  type MigrationBatchUpdate,
  type MigrationCursor,
  type MigrationItem,
  type MigrationProgress,
  type MigrationResult,
} from './types.js';

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 50;

export async function migrateStore(options: MigrateStoreOptions): Promise<MigrationResult> {
  const {
    store,
    embedder,
    batchSize = DEFAULT_BATCH_SIZE,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    onProgress,
    signal,
  } = options;

  if (batchSize <= 0) throw new RangeError('batchSize must be > 0');
  if (maxRetries < 0) throw new RangeError('maxRetries must be >= 0');
  if (backoffMs < 0) throw new RangeError('backoffMs must be >= 0');

  const emit = (progress: MigrationProgress): void => {
    if (!onProgress) return;
    try {
      onProgress(progress);
    } catch {
      // Progress callbacks are strictly informational — swallow subscriber
      // failures so they cannot break the migration itself.
    }
  };

  const startedAt = Date.now();
  const errors: string[] = [];

  const itemsTotal = await store.countItems();
  const existing = await store.loadCursor();
  const resumed = existing !== null;

  const cursor: MigrationCursor = existing ?? {
    storeId: store.storeId,
    lastProcessedId: null,
    itemsDone: 0,
    itemsTotal,
    startedAt,
    updatedAt: startedAt,
  };
  // If total changed between runs (rows added/removed), prefer the current count.
  cursor.itemsTotal = itemsTotal;

  emit({ step: 'start', itemsDone: cursor.itemsDone, itemsTotal, batchMs: 0 });

  if (itemsTotal === 0) {
    // Nothing to do — still bump the version so fresh stores mark correctly.
    await store.setVersion(EMBEDDINGS_VERSION);
    await store.clearCursor();
    emit({ step: 'finish', itemsDone: 0, itemsTotal: 0, batchMs: 0 });
    return {
      success: true,
      itemsMigrated: 0,
      itemsTotal: 0,
      durationMs: Date.now() - startedAt,
      resumed,
      aborted: false,
      versionBumped: true,
      errors,
    };
  }

  while (true) {
    if (signal?.aborted) {
      emit({
        step: 'aborted',
        itemsDone: cursor.itemsDone,
        itemsTotal: cursor.itemsTotal,
        batchMs: 0,
        error: describeAbort(signal),
      });
      return {
        success: false,
        itemsMigrated: cursor.itemsDone,
        itemsTotal: cursor.itemsTotal,
        durationMs: Date.now() - startedAt,
        resumed,
        aborted: true,
        versionBumped: false,
        errors,
      };
    }

    const batch = await store.iterItems(cursor.lastProcessedId, batchSize);
    if (batch.length === 0) break;

    const batchStart = Date.now();
    const committed = await commitBatchWithRetry({
      store,
      embedder,
      batch,
      cursor,
      maxRetries,
      backoffMs,
      emit,
      errors,
    });

    if (!committed) {
      // Exhausted retries — bail out without bumping the version so the next
      // run re-tries this batch from the last good cursor.
      return {
        success: false,
        itemsMigrated: cursor.itemsDone,
        itemsTotal: cursor.itemsTotal,
        durationMs: Date.now() - startedAt,
        resumed,
        aborted: false,
        versionBumped: false,
        errors,
      };
    }

    const batchMs = Date.now() - batchStart;
    emit({
      step: 'batch',
      itemsDone: cursor.itemsDone,
      itemsTotal: cursor.itemsTotal,
      batchMs,
    });
  }

  // All batches committed — mark the schema and drop the resume cursor.
  await store.setVersion(EMBEDDINGS_VERSION);
  await store.clearCursor();

  emit({
    step: 'finish',
    itemsDone: cursor.itemsDone,
    itemsTotal: cursor.itemsTotal,
    batchMs: 0,
  });

  return {
    success: true,
    itemsMigrated: cursor.itemsDone,
    itemsTotal: cursor.itemsTotal,
    durationMs: Date.now() - startedAt,
    resumed,
    aborted: false,
    versionBumped: true,
    errors,
  };
}

interface CommitContext {
  store: MigrateStoreOptions['store'];
  embedder: MigrateStoreOptions['embedder'];
  batch: MigrationItem[];
  cursor: MigrationCursor;
  maxRetries: number;
  backoffMs: number;
  emit: (p: MigrationProgress) => void;
  errors: string[];
}

/**
 * Embed a batch, write it, and commit — retrying the whole sequence (including
 * re-embedding) up to `maxRetries` times on failure. Returns `true` on success,
 * `false` when retries are exhausted.
 */
async function commitBatchWithRetry(ctx: CommitContext): Promise<boolean> {
  const { store, batch, cursor, maxRetries, backoffMs, emit, errors } = ctx;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const outcome = await attemptBatchOnce(ctx);
    if (outcome.ok) return true;

    const firstId = batch[0]?.id ?? '?';
    errors.push(
      `[${store.storeId}] batch attempt ${attempt + 1} (ids ${firstId}..): ${outcome.error}`,
    );
    emit({
      step: 'retry',
      itemsDone: cursor.itemsDone,
      itemsTotal: cursor.itemsTotal,
      batchMs: 0,
      attempt: attempt + 1,
      error: outcome.error,
    });

    if (attempt === maxRetries) return false;
    await sleep(backoffMs * Math.pow(2, attempt));
  }
  return false;
}

type AttemptOutcome = { ok: true } | { ok: false; error: string };

/**
 * A single embed+commit attempt. Any thrown error (embed, update, save, or
 * commit) is caught once here, rollback is attempted, and the error is
 * surfaced through the returned outcome. This keeps the retry loop flat.
 */
async function attemptBatchOnce(ctx: CommitContext): Promise<AttemptOutcome> {
  const { store, embedder, batch, cursor, errors } = ctx;

  try {
    const texts = batch.map((item) => item.sourceText);
    const vectors = await embedder.embedBatch(texts);
    if (vectors.length !== batch.length) {
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${batch.length} inputs`,
      );
    }

    const updates: MigrationBatchUpdate[] = batch.map((item, i) => ({
      id: item.id,
      // Safe: `vectors.length === batch.length` guarded above.
      embedding: vectors[i]!,
    }));

    await store.beginTransaction();
    try {
      await store.updateBatch(updates);
      const lastId = batch[batch.length - 1]!.id;
      const next: MigrationCursor = {
        ...cursor,
        lastProcessedId: lastId,
        itemsDone: cursor.itemsDone + batch.length,
        updatedAt: Date.now(),
      };
      await store.saveCursor(next);
      await store.commit();
      cursor.lastProcessedId = next.lastProcessedId;
      cursor.itemsDone = next.itemsDone;
      cursor.updatedAt = next.updatedAt;
      return { ok: true };
    } catch (inner) {
      await safeRollback(store, errors);
      throw inner;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Roll back, but never mask the original error. A rollback failure is still
 * recorded in `errors` so an operator can see it — just demoted so the real
 * cause (the thing that made us roll back) remains the one that bubbles up.
 */
async function safeRollback(
  store: MigrateStoreOptions['store'],
  errors: string[],
): Promise<void> {
  try {
    await store.rollback();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`[${store.storeId}] rollback failed: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAbort(signal: AbortSignal): string {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'aborted';
}
