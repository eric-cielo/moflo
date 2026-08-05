/**
 * #1396 (Epic #1392) — the entry cache must carry the FULL row shape.
 *
 * Symptom in the field: every `mcp__moflo__memory_store` call that passed
 * `tags` read back with `tags: []`, `accessCount: 0`, and a `storedAt` equal to
 * roughly *retrieval* time. `metadata` on the same call survived.
 *
 * Root cause: `bridgeStoreEntry` warmed the entry cache with
 * `{id,key,namespace,content,embedding,metadata}` only, while
 * `bridgeGetEntry`'s cache-hit branch returns the cached value verbatim and
 * substitutes defaults for anything missing — `tags: []`, `accessCount: 0`,
 * and `new Date()` for the timestamps. So for the cache's TTL after any write,
 * a retrieve reported plausible-looking but fabricated values. #1064 had added
 * `metadata` to that cache write for exactly this reason, which is precisely
 * why metadata survived and the rest did not.
 *
 * Nothing was ever lost on disk — the INSERT always wrote tags correctly. These
 * tests therefore assert the CACHE-HIT path specifically (`cacheHit === true`),
 * because a test that silently fell through to the disk read would pass against
 * the unfixed code and prove nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  _resetProjectRootForTest,
  shutdownBridge,
} from '../../memory/bridge-core.js';
import { bridgeStoreEntry, bridgeGetEntry, bridgeStoreEntries } from '../../memory/memory-bridge.js';

describe('entry cache shape (#1396)', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;
  let originalCwd: string;
  let originalProjectDir: string | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1396-cache-'));
    projectRoot = tempDir;
    fs.mkdirSync(path.join(projectRoot, '.moflo'), { recursive: true });
    dbPath = path.join(projectRoot, '.moflo', 'moflo.db');

    originalCwd = process.cwd();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    await shutdownBridge();
    _resetProjectRootForTest();
  });

  afterEach(async () => {
    await shutdownBridge();
    _resetProjectRootForTest();
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
    try { process.chdir(originalCwd); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('round-trips tags through a cache hit', async () => {
    const stored = await bridgeStoreEntry({
      key: 'k-tags',
      value: 'body',
      namespace: 'ns-1396',
      tags: ['alpha', 'beta'],
      upsert: true,
    });
    expect(stored?.success).toBe(true);

    const got = await bridgeGetEntry({ key: 'k-tags', namespace: 'ns-1396' });

    // The assertion that makes this test meaningful: the store warmed the
    // cache, so this read MUST be served from it. If it ever falls through to
    // disk, the tags below would pass for the wrong reason.
    expect(got?.cacheHit).toBe(true);
    expect(got?.entry?.tags).toEqual(['alpha', 'beta']);
  });

  it('keeps tags and metadata intact together on a cache hit', async () => {
    await bridgeStoreEntry({
      key: 'k-both',
      value: 'body',
      namespace: 'ns-1396',
      tags: ['verify', 'sdd'],
      metadata: { type: 'verify-record', overall: 'PASS' },
      upsert: true,
    });

    const got = await bridgeGetEntry({ key: 'k-both', namespace: 'ns-1396' });
    expect(got?.cacheHit).toBe(true);
    expect(got?.entry?.tags).toEqual(['verify', 'sdd']);
    expect(JSON.parse(got!.entry!.metadata!)).toMatchObject({
      type: 'verify-record',
      overall: 'PASS',
    });
  });

  it('reports an empty tag list — not a crash — when none were supplied', async () => {
    await bridgeStoreEntry({ key: 'k-none', value: 'body', namespace: 'ns-1396', upsert: true });

    const got = await bridgeGetEntry({ key: 'k-none', namespace: 'ns-1396' });
    expect(got?.cacheHit).toBe(true);
    expect(got?.entry?.tags).toEqual([]);
  });

  it('reports the store time, not the retrieval time, as createdAt', async () => {
    const before = Date.now();
    await bridgeStoreEntry({ key: 'k-time', value: 'body', namespace: 'ns-1396', tags: ['t'], upsert: true });
    const after = Date.now();

    const got = await bridgeGetEntry({ key: 'k-time', namespace: 'ns-1396' });
    expect(got?.cacheHit).toBe(true);

    // Bounded against the store window rather than a sleep — a wall-clock delay
    // is the flakiness vector CLAUDE.md's broken-window rule calls out, and the
    // pre-fix value (a fresh `new Date()` at read time) is an ISO STRING, so it
    // fails the numeric check regardless of how fast the test runs.
    const createdAt = got!.entry!.createdAt as number;
    expect(typeof createdAt).toBe('number');
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);

    // And it must agree with what actually landed on disk.
    const probeDb = new DatabaseSync(dbPath);
    try {
      const row = probeDb.prepare(
        'SELECT created_at, tags FROM memory_entries WHERE key = ? AND namespace = ?',
      ).get('k-time', 'ns-1396') as { created_at: number; tags: string | null };
      expect(row.created_at).toBe(createdAt);
      expect(JSON.parse(row.tags!)).toEqual(['t']);
    } finally {
      probeDb.close();
    }
  });

  it('increments accessCount across repeated reads and holds createdAt steady', async () => {
    await bridgeStoreEntry({ key: 'k-count', value: 'body', namespace: 'ns-1396', tags: ['x'], upsert: true });

    const first = await bridgeGetEntry({ key: 'k-count', namespace: 'ns-1396' });
    const second = await bridgeGetEntry({ key: 'k-count', namespace: 'ns-1396' });
    const third = await bridgeGetEntry({ key: 'k-count', namespace: 'ns-1396' });

    expect(first?.entry?.accessCount).toBe(1);
    expect(second?.entry?.accessCount).toBe(2);
    expect(third?.entry?.accessCount).toBe(3);

    // Timestamps are a property of the row, not of reading it.
    expect(second?.entry?.createdAt).toBe(first?.entry?.createdAt);
    expect(third?.entry?.createdAt).toBe(first?.entry?.createdAt);
    expect(third?.entry?.tags).toEqual(['x']);
  });

  it('reports hasEmbedding consistently across a cache hit and a disk read', async () => {
    await bridgeStoreEntry({
      key: 'k-emb',
      value: 'body with enough text to embed',
      namespace: 'ns-1396',
      tags: ['e'],
      generateEmbeddingFlag: true,
      upsert: true,
    });

    const fromCache = await bridgeGetEntry({ key: 'k-emb', namespace: 'ns-1396' });
    expect(fromCache?.cacheHit).toBe(true);

    // Drop the cache the way expiry would, then read the same row from disk.
    // Pre-fix these two disagreed: the store path cached `embedding` with no
    // `hasEmbedding`, the read path cached `hasEmbedding` with no `embedding`,
    // and the cache-hit branch only ever consulted `embedding` — so the same
    // row flipped to hasEmbedding:false on the second retrieve.
    await shutdownBridge();
    _resetProjectRootForTest();

    const fromDisk = await bridgeGetEntry({ key: 'k-emb', namespace: 'ns-1396' });
    expect(fromDisk?.cacheHit).toBe(false);
    expect(fromDisk?.entry?.hasEmbedding).toBe(fromCache?.entry?.hasEmbedding);
    expect(fromDisk?.entry?.tags).toEqual(['e']);

    // Now warm again from that disk read and confirm the re-cached shape holds.
    const reCached = await bridgeGetEntry({ key: 'k-emb', namespace: 'ns-1396' });
    expect(reCached?.cacheHit).toBe(true);
    expect(reCached?.entry?.hasEmbedding).toBe(fromDisk?.entry?.hasEmbedding);
    expect(reCached?.entry?.tags).toEqual(['e']);
  });

  it('treats a pre-#1396 partial cache value as a miss and self-heals from disk', async () => {
    // An in-place upgrade can leave old-shape values sitting in a live L1 cache.
    // Serving one means fabricating the missing columns — the bug itself — so
    // the reader must fall through to disk instead.
    await bridgeStoreEntry({
      key: 'k-stale',
      value: 'body',
      namespace: 'ns-1396',
      tags: ['kept'],
      upsert: true,
    });

    // Re-plant the exact pre-fix shape under the same cache key.
    const { getRegistry } = await import('../../memory/bridge-core.js');
    const registry = await getRegistry();
    const cache = registry?.get('tieredCache');
    expect(cache, 'tiered cache must be available for this test to mean anything').toBeTruthy();
    await cache.set('entry:ns-1396:k-stale', {
      id: 'entry_stale',
      key: 'k-stale',
      namespace: 'ns-1396',
      content: 'body',
      embedding: null,
      metadata: '{}',
    });

    const got = await bridgeGetEntry({ key: 'k-stale', namespace: 'ns-1396' });

    // Fell through to disk rather than serving the partial...
    expect(got?.cacheHit).toBe(false);
    // ...and therefore reported the row's real tags instead of `[]`.
    expect(got?.entry?.tags).toEqual(['kept']);
    expect(typeof got?.entry?.createdAt).toBe('number');

    // The disk read re-cached the full shape, so the next read is a clean hit.
    const next = await bridgeGetEntry({ key: 'k-stale', namespace: 'ns-1396' });
    expect(next?.cacheHit).toBe(true);
    expect(next?.entry?.tags).toEqual(['kept']);
  });

  it('warms the full shape from the bulk-store path too', async () => {
    // bridgeStoreEntries carries its own copy of the cache-value construction,
    // so it regresses independently of the single-store path.
    const results = await bridgeStoreEntries([
      { key: 'b-1', value: 'body one', namespace: 'ns-1396', tags: ['one'], upsert: true },
      { key: 'b-2', value: 'body two', namespace: 'ns-1396', tags: ['two', 'more'], upsert: true },
    ]);
    expect(results?.every(r => r.success)).toBe(true);

    const one = await bridgeGetEntry({ key: 'b-1', namespace: 'ns-1396' });
    const two = await bridgeGetEntry({ key: 'b-2', namespace: 'ns-1396' });

    expect(one?.cacheHit).toBe(true);
    expect(two?.cacheHit).toBe(true);
    expect(one?.entry?.tags).toEqual(['one']);
    expect(two?.entry?.tags).toEqual(['two', 'more']);
    expect(typeof one?.entry?.createdAt).toBe('number');
  });
});
