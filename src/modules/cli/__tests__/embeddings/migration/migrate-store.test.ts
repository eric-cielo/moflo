/**
 * Unit tests for the resumable batch-embed migration driver.
 *
 * All tests run against {@link InMemoryMigrationStore} + {@link MockBatchEmbedder}
 * so they're fully offline and cover the driver's contract without needing
 * a real ONNX runtime or sql.js file.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  EMBEDDINGS_VERSION,
  InMemoryMigrationStore,
  migrateStore,
  type InMemoryItem,
  type MigrationProgress,
} from '../../../src/embeddings/migration/index.js';
import { MockBatchEmbedder } from '../../../src/embeddings/__tests__/migration/mock-batch-embedder.js';

function makeItems(count: number): InMemoryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${String(i).padStart(4, '0')}`,
    sourceText: `content-${i}`,
  }));
}

describe('migrateStore', () => {
  describe('happy path', () => {
    it('embeds every item, bumps version, clears cursor', async () => {
      const store = new InMemoryMigrationStore({
        storeId: 'mem:entries',
        items: makeItems(5),
        initialVersion: null,
      });
      const embedder = new MockBatchEmbedder(8);

      const result = await migrateStore({ store, embedder, batchSize: 2 });

      expect(result.success).toBe(true);
      expect(result.itemsMigrated).toBe(5);
      expect(result.itemsTotal).toBe(5);
      expect(result.aborted).toBe(false);
      expect(result.resumed).toBe(false);
      expect(result.versionBumped).toBe(true);
      expect(store.getVersionSync()).toBe(EMBEDDINGS_VERSION);
      expect(store.getCursor()).toBeNull();

      // Every item got its embedding written.
      for (const item of store.snapshot()) {
        expect(item.embedding).toBeInstanceOf(Float32Array);
        expect(item.embedding!.length).toBe(8);
      }
    });

    it('handles empty store by bumping version immediately', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: [] });
      const embedder = new MockBatchEmbedder();

      const result = await migrateStore({ store, embedder });

      expect(result.success).toBe(true);
      expect(result.itemsMigrated).toBe(0);
      expect(store.getVersionSync()).toBe(EMBEDDINGS_VERSION);
      expect(store.stats.beginTransaction).toBe(0);
    });

    it('skips items with empty source text when counting and iterating', async () => {
      const store = new InMemoryMigrationStore({
        storeId: 's',
        items: [
          { id: 'a', sourceText: 'hello' },
          { id: 'b', sourceText: '' },
          { id: 'c', sourceText: 'world' },
        ],
      });
      const embedder = new MockBatchEmbedder();

      const result = await migrateStore({ store, embedder, batchSize: 10 });

      expect(result.itemsTotal).toBe(2);
      expect(result.itemsMigrated).toBe(2);
      expect(embedder.lastInputs).toEqual(['hello', 'world']);
    });
  });

  describe('progress events', () => {
    it('emits start, one batch per commit, and finish in order', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(5) });
      const embedder = new MockBatchEmbedder();
      const events: MigrationProgress[] = [];

      await migrateStore({
        store,
        embedder,
        batchSize: 2,
        onProgress: (p) => events.push(p),
      });

      // 5 items / batchSize 2 → 3 batches → 1 start + 3 batch + 1 finish.
      expect(events.map((e) => e.step)).toEqual([
        'start',
        'batch',
        'batch',
        'batch',
        'finish',
      ]);
      expect(events[0]!.itemsDone).toBe(0);
      expect(events[1]!.itemsDone).toBe(2);
      expect(events[2]!.itemsDone).toBe(4);
      expect(events[3]!.itemsDone).toBe(5);
      expect(events[4]!.itemsDone).toBe(5);
      expect(events[4]!.itemsTotal).toBe(5);
      // Batch events carry a non-negative batchMs.
      for (const ev of events.slice(1, 4)) {
        expect(ev.batchMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('callback errors do not break the migration', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(4) });
      const embedder = new MockBatchEmbedder();
      const callback = vi.fn(() => {
        throw new Error('subscriber explosion');
      });

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        onProgress: callback,
      });

      expect(result.success).toBe(true);
      expect(result.itemsMigrated).toBe(4);
      expect(callback.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe('transaction rollback + retry', () => {
    it('rolls back and retries on embedder failure, then succeeds', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(3) });
      // Fail on the first call; the retry re-embeds and commits.
      const embedder = new MockBatchEmbedder(8, { failAt: 1 });
      const events: MigrationProgress[] = [];

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 3,
        backoffMs: 0,
        onProgress: (p) => events.push(p),
      });

      expect(result.success).toBe(true);
      expect(result.itemsMigrated).toBe(3);
      expect(embedder.calls).toBe(2); // first attempt failed; retry succeeded.
      // Embedder throws before `beginTransaction`, so no rollback is needed.
      expect(store.stats.rollback).toBe(0);
      expect(events.some((e) => e.step === 'retry' && e.attempt === 1)).toBe(true);
    });

    it('rolls back and retries on updateBatch failure', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(2) });
      let tripped = false;
      store.injector.beforeUpdate = () => {
        if (!tripped) {
          tripped = true;
          throw new Error('injected updateBatch failure');
        }
      };
      const embedder = new MockBatchEmbedder();

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        backoffMs: 0,
      });

      expect(result.success).toBe(true);
      expect(store.stats.rollback).toBe(1);
      expect(store.stats.commit).toBe(1);
      expect(embedder.calls).toBe(2); // re-embedded on retry
    });

    it('gives up after maxRetries and returns success=false without bumping version', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(2) });
      store.injector.beforeCommit = () => {
        throw new Error('commit always fails');
      };
      const embedder = new MockBatchEmbedder();

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        maxRetries: 2,
        backoffMs: 0,
      });

      expect(result.success).toBe(false);
      expect(result.versionBumped).toBe(false);
      expect(store.getVersionSync()).toBeNull();
      expect(store.stats.rollback).toBe(3); // 1 initial + 2 retries = 3 attempts
      expect(result.errors.length).toBe(3);
    });

    it('surfaces rollback failures in the errors list without masking the original', async () => {
      const store = new InMemoryMigrationStore({ storeId: 'store-x', items: makeItems(2) });
      store.injector.beforeUpdate = () => {
        throw new Error('original failure');
      };
      store.injector.beforeRollback = () => {
        throw new Error('rollback exploded');
      };
      const embedder = new MockBatchEmbedder();

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        maxRetries: 0,
        backoffMs: 0,
      });

      expect(result.success).toBe(false);
      // Both the original failure and the rollback failure make it into errors,
      // tagged with the store id so operators can find which store failed.
      expect(result.errors.some((e) => e.includes('[store-x]') && e.includes('original failure'))).toBe(true);
      expect(result.errors.some((e) => e.includes('[store-x]') && e.includes('rollback failed: rollback exploded'))).toBe(true);
    });

    it('rejects an embedder that returns the wrong count of vectors', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(3) });
      const embedder = new MockBatchEmbedder(8, { miscountAt: 1 });

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 3,
        maxRetries: 0,
        backoffMs: 0,
      });

      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/returned 2 vectors for 3 inputs/);
    });
  });

  describe('version bump semantics', () => {
    it('does not bump version on interrupted runs', async () => {
      const store = new InMemoryMigrationStore({
        storeId: 's',
        items: makeItems(6),
        initialVersion: 1,
      });
      const controller = new AbortController();

      const embedder = new MockBatchEmbedder();
      const stopAfter = 2; // batches
      let batchesSeen = 0;

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.step === 'batch') {
            batchesSeen++;
            if (batchesSeen === stopAfter) controller.abort('user cancelled');
          }
        },
      });

      expect(result.aborted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.versionBumped).toBe(false);
      expect(store.getVersionSync()).toBe(1); // unchanged
      expect(result.itemsMigrated).toBe(4);
      expect(store.getCursor()).not.toBeNull();
    });

    it('only bumps version after every batch commits', async () => {
      const store = new InMemoryMigrationStore({
        storeId: 's',
        items: makeItems(10),
        initialVersion: null,
      });
      const embedder = new MockBatchEmbedder();

      // Observe: version must stay null during batches, flip to EMBEDDINGS_VERSION after finish.
      const versionsDuring: (number | null)[] = [];
      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        onProgress: (p) => {
          if (p.step === 'batch') versionsDuring.push(store.getVersionSync());
        },
      });

      expect(result.success).toBe(true);
      for (const v of versionsDuring) expect(v).toBeNull();
      expect(store.getVersionSync()).toBe(EMBEDDINGS_VERSION);
    });
  });

  describe('resumability + idempotency', () => {
    it('resumes from persisted cursor after an abort and produces identical end state', async () => {
      const items = makeItems(6);

      // First run: abort after 2 batches.
      const storeA = new InMemoryMigrationStore({ storeId: 's', items, initialVersion: null });
      const controller = new AbortController();
      let batches = 0;

      await migrateStore({
        store: storeA,
        embedder: new MockBatchEmbedder(),
        batchSize: 2,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.step === 'batch') {
            batches++;
            if (batches === 2) controller.abort();
          }
        },
      });

      // Confirm cursor was persisted and some items have embeddings.
      const cursorMid = storeA.getCursor();
      expect(cursorMid).not.toBeNull();
      expect(cursorMid!.itemsDone).toBe(4);
      expect(storeA.getVersionSync()).toBeNull();

      // Second run: resume. (New embedder so we can count calls cleanly.)
      const embedderB = new MockBatchEmbedder();
      const result = await migrateStore({
        store: storeA,
        embedder: embedderB,
        batchSize: 2,
      });

      expect(result.success).toBe(true);
      expect(result.resumed).toBe(true);
      expect(result.itemsMigrated).toBe(6); // running total from cursor
      expect(storeA.getVersionSync()).toBe(EMBEDDINGS_VERSION);
      expect(storeA.getCursor()).toBeNull();

      // On resume we only re-embedded the remaining 2 items (1 batch).
      expect(embedderB.calls).toBe(1);
      expect(embedderB.history[0]!.sort()).toEqual(['content-4', 'content-5']);

      // Compare final state against a clean full run — they should match.
      const storeC = new InMemoryMigrationStore({ storeId: 's', items, initialVersion: null });
      await migrateStore({ store: storeC, embedder: new MockBatchEmbedder(), batchSize: 2 });

      const a = storeA.snapshot();
      const c = storeC.snapshot();
      expect(a.length).toBe(c.length);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]!.id).toBe(c[i]!.id);
        expect(Array.from(a[i]!.embedding!)).toEqual(Array.from(c[i]!.embedding!));
      }
    });

    it('re-running a completed migration is a no-op against the same store', async () => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(3) });
      const embedder = new MockBatchEmbedder();

      await migrateStore({ store, embedder, batchSize: 2 });
      const firstVersion = store.getVersionSync();
      const firstSnapshot = store.snapshot();

      // Second call: no cursor → walks items, re-embeds them (idempotent),
      // bumps version again to the same value. The driver does not
      // short-circuit based on the existing version — that check belongs to
      // the caller that decides whether to trigger migration in the first
      // place (story 3). We just assert it does not corrupt anything.
      const second = await migrateStore({ store, embedder, batchSize: 2 });
      expect(second.success).toBe(true);
      expect(store.getVersionSync()).toBe(firstVersion);
      expect(store.snapshot().map((i) => i.id)).toEqual(firstSnapshot.map((i) => i.id));
    });
  });

  describe('abort', () => {
    it('returns cleanly when aborted before any batch', async () => {
      const controller = new AbortController();
      controller.abort('cancelled before start');
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(4) });
      const embedder = new MockBatchEmbedder();

      const result = await migrateStore({
        store,
        embedder,
        batchSize: 2,
        signal: controller.signal,
      });

      expect(result.aborted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.itemsMigrated).toBe(0);
      expect(embedder.calls).toBe(0);
      expect(store.getVersionSync()).toBeNull();
    });
  });

  describe('option validation', () => {
    it.each([
      { name: 'batchSize <= 0', opt: { batchSize: 0 } },
      { name: 'maxRetries < 0', opt: { maxRetries: -1 } },
      { name: 'backoffMs < 0', opt: { backoffMs: -1 } },
    ])('rejects $name', async ({ opt }) => {
      const store = new InMemoryMigrationStore({ storeId: 's', items: makeItems(1) });
      const embedder = new MockBatchEmbedder();
      await expect(migrateStore({ store, embedder, ...opt })).rejects.toThrow(RangeError);
    });
  });
});
