/**
 * Coordinator tests — runs the full UX flow over InMemoryMigrationStore +
 * MockBatchEmbedder, capturing output into a buffer and asserting on the
 * human transcript as well as on the structured summary.
 */
import { describe, it, expect } from 'vitest';

import {
  InMemoryMigrationStore,
  runUpgrade,
  UpgradeRenderer,
} from '../../../embeddings/migration/index.js';
import { MockBatchEmbedder } from '../../../embeddings/__tests__/migration/mock-batch-embedder.js';
import { BufferStream, makeClock, makeItems } from './upgrade-test-utils.js';

describe('runUpgrade — happy path', () => {
  it('migrates every step, bumps versions, emits a clean transcript', async () => {
    const out = new BufferStream();
    const clock = makeClock();

    const storeA = new InMemoryMigrationStore({
      storeId: 'a',
      items: makeItems('a', 10),
      initialVersion: null,
    });
    const storeB = new InMemoryMigrationStore({
      storeId: 'b',
      items: makeItems('b', 5),
      initialVersion: null,
    });

    const summary = await runUpgrade({
      plan: {
        steps: [
          { label: 'Re-index memory database', store: storeA, embedder: new MockBatchEmbedder() },
          { label: 'Re-index guidance shards', store: storeB, embedder: new MockBatchEmbedder() },
        ],
      },
      out,
      isTTY: false,
      installSigintHandler: false,
      now: clock.now,
      batchSize: 3,
    });

    expect(summary.status).toBe('completed');
    expect(summary.totalItemsMigrated).toBe(15);
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps[0]!.versionBumped).toBe(true);
    expect(summary.steps[1]!.versionBumped).toBe(true);

    // Announcement appeared before step 1.
    expect(out.buffer.indexOf('Upgrading moflo memory')).toBeLessThan(
      out.buffer.indexOf('Step 1/2'),
    );
    expect(out.buffer).toContain('Steps:');
    expect(out.buffer).toContain('1. Re-index memory database (10 items)');
    expect(out.buffer).toContain('2. Re-index guidance shards (5 items)');

    // Step boundaries printed.
    expect(out.buffer).toContain('✓ Step 1/2 complete — Re-index memory database (10 items)');
    expect(out.buffer).toContain('✓ Step 2/2 complete — Re-index guidance shards (5 items)');

    // Final summary printed.
    expect(out.buffer).toMatch(/✓ Memory upgrade complete — 15 items re-indexed in \d+s\./);
  });

  it('announces a "resuming" line when any store has an in-flight cursor', async () => {
    const store = new InMemoryMigrationStore({
      storeId: 'a',
      items: makeItems('a', 5),
      initialVersion: null,
    });
    // Seed a cursor as if a prior run had aborted at 2/5.
    await store.beginTransaction();
    await store.saveCursor({
      storeId: 'a',
      lastProcessedId: 'a-0001',
      itemsDone: 2,
      itemsTotal: 5,
      startedAt: 0,
      updatedAt: 0,
    });
    await store.commit();

    const out = new BufferStream();
    const summary = await runUpgrade({
      plan: {
        steps: [{ label: 'Re-index memory database', store, embedder: new MockBatchEmbedder() }],
      },
      out,
      isTTY: false,
      installSigintHandler: false,
      now: makeClock().now,
      batchSize: 3,
    });

    expect(summary.status).toBe('completed');
    expect(out.buffer).toContain('Resuming where we left off: 2 of 5 items already done.');
  });
});

describe('runUpgrade — abort', () => {
  it('stops cleanly when an external AbortSignal fires, returns status=aborted', async () => {
    const out = new BufferStream();

    const store = new InMemoryMigrationStore({
      storeId: 'a',
      items: makeItems('a', 10),
      initialVersion: null,
    });
    const embedder = new MockBatchEmbedder();
    const abortAfterFirstEmbed = new AbortController();

    // Trip on the 2nd embed call — first batch commits, then abort lands at
    // the next batch boundary.
    let calls = 0;
    const original = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts: string[]) => {
      calls++;
      if (calls === 1) abortAfterFirstEmbed.abort('external');
      return original(texts);
    };

    const summary = await runUpgrade({
      plan: {
        steps: [{ label: 'Re-index memory database', store, embedder }],
      },
      out,
      isTTY: false,
      installSigintHandler: false,
      signal: abortAfterFirstEmbed.signal,
      now: makeClock().now,
      batchSize: 3,
    });

    expect(summary.status).toBe('aborted');
    expect(summary.steps[0]!.versionBumped).toBe(false);
    expect(summary.steps[0]!.aborted).toBe(true);
    expect(out.buffer).toMatch(
      /Paused\. Will resume automatically next time moflo runs\. \(\d+ of 10 items done\.\)/,
    );
    // No success line.
    expect(out.buffer).not.toContain('✓ Memory upgrade complete');
  });

  it('does not run a second step after the first aborts', async () => {
    const out = new BufferStream();

    const storeA = new InMemoryMigrationStore({
      storeId: 'a',
      items: makeItems('a', 10),
      initialVersion: null,
    });
    const storeB = new InMemoryMigrationStore({
      storeId: 'b',
      items: makeItems('b', 10),
      initialVersion: null,
    });

    const aborter = new AbortController();
    const embedderA = new MockBatchEmbedder();
    const original = embedderA.embedBatch.bind(embedderA);
    embedderA.embedBatch = async (texts: string[]) => {
      aborter.abort('external');
      return original(texts);
    };

    const summary = await runUpgrade({
      plan: {
        steps: [
          { label: 'A', store: storeA, embedder: embedderA },
          { label: 'B', store: storeB, embedder: new MockBatchEmbedder() },
        ],
      },
      out,
      isTTY: false,
      installSigintHandler: false,
      signal: aborter.signal,
      now: makeClock().now,
      batchSize: 3,
    });

    expect(summary.status).toBe('aborted');
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]!.label).toBe('A');
    expect(storeB.stats.beginTransaction).toBe(0);
  });
});

describe('runUpgrade — failure', () => {
  it('reports status=failed when a step exhausts retries', async () => {
    const out = new BufferStream();
    const store = new InMemoryMigrationStore({
      storeId: 'a',
      items: makeItems('a', 10),
      initialVersion: null,
    });
    // Force every embed call to fail.
    const embedder = new MockBatchEmbedder();
    let call = 0;
    embedder.embedBatch = async () => {
      call++;
      throw new Error(`boom-${call}`);
    };

    const summary = await runUpgrade({
      plan: {
        steps: [{ label: 'Re-index memory database', store, embedder }],
      },
      out,
      isTTY: false,
      installSigintHandler: false,
      now: makeClock().now,
      batchSize: 3,
      maxRetries: 1,
      backoffMs: 0,
    });

    expect(summary.status).toBe('failed');
    expect(summary.steps[0]!.versionBumped).toBe(false);
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(out.buffer).toContain('Upgrade failed while re-indexing "Re-index memory database"');
  });
});

describe('runUpgrade — SIGINT handler lifecycle', () => {
  it('leaves process SIGINT listener count unchanged after a successful run', async () => {
    const before = process.listenerCount('SIGINT');

    await runUpgrade({
      plan: {
        steps: [
          {
            label: 'X',
            store: new InMemoryMigrationStore({ storeId: 'x', items: makeItems('x', 3) }),
            embedder: new MockBatchEmbedder(),
          },
        ],
      },
      out: new BufferStream(),
      isTTY: false,
      installSigintHandler: true,
      now: makeClock().now,
      batchSize: 2,
    });

    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('does not install a SIGINT listener when installSigintHandler=false', async () => {
    const before = process.listenerCount('SIGINT');

    // Mid-run listener count must not increase.
    let duringRunCount = -1;
    const store = new InMemoryMigrationStore({ storeId: 'x', items: makeItems('x', 5) });
    const embedder = new MockBatchEmbedder();
    const original = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts: string[]) => {
      if (duringRunCount === -1) duringRunCount = process.listenerCount('SIGINT');
      return original(texts);
    };

    await runUpgrade({
      plan: {
        steps: [{ label: 'X', store, embedder }],
      },
      out: new BufferStream(),
      isTTY: false,
      installSigintHandler: false,
      now: makeClock().now,
      batchSize: 2,
    });

    expect(duringRunCount).toBe(before);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('removes the SIGINT listener even when a step fails', async () => {
    const before = process.listenerCount('SIGINT');
    const store = new InMemoryMigrationStore({ storeId: 'x', items: makeItems('x', 5) });
    const embedder = new MockBatchEmbedder();
    embedder.embedBatch = async () => {
      throw new Error('boom');
    };

    await runUpgrade({
      plan: {
        steps: [{ label: 'X', store, embedder }],
      },
      out: new BufferStream(),
      isTTY: false,
      installSigintHandler: true,
      now: makeClock().now,
      maxRetries: 0,
      backoffMs: 0,
    });

    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('runUpgrade — renderer injection', () => {
  it('accepts a pre-built renderer and routes events through it', async () => {
    const out = new BufferStream();
    const clock = makeClock();
    const renderer = new UpgradeRenderer({ out, isTTY: false, now: clock.now });

    const summary = await runUpgrade({
      plan: {
        steps: [
          {
            label: 'Re-index memory database',
            store: new InMemoryMigrationStore({ storeId: 'a', items: makeItems('a', 3) }),
            embedder: new MockBatchEmbedder(),
          },
        ],
      },
      renderer,
      installSigintHandler: false,
      now: clock.now,
    });

    expect(summary.status).toBe('completed');
    expect(out.buffer).toContain('Upgrading moflo memory');
    expect(out.buffer).toContain('✓ Step 1/1 complete');
  });
});
