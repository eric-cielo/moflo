/**
 * #1402 — the `access_count` write on an entry-cache hit is throttled per key.
 *
 * #1396 made a cache hit bump `access_count`, which is correct: the counter feeds
 * `sortBy('accessCount')` and stats, so a row read repeatedly inside the cache
 * TTL must not look untouched. But `bridgeGetEntry` runs inside fan-out loops —
 * the dashboard's `/api/schedules` and `/api/spells` handlers issue up to 300
 * `getEntry` calls between them and the browser polls both every 5s, so a
 * write-per-hit is ~60 writes/sec against the same handful of keys.
 *
 * The contract these tests pin down: **defer writes, never lose counts.** The
 * caller-visible `accessCount` still increments on every single read; the DB
 * write is coalesced; and once the interval elapses the persisted total reflects
 * every accumulated hit.
 *
 * Time is driven with `vi.setSystemTime`, never a real sleep — a 30s interval
 * tested by sleeping would be both slow and exactly the flakiness vector
 * CLAUDE.md's broken-window rule calls out.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  _resetProjectRootForTest,
  shutdownBridge,
} from '../../memory/bridge-core.js';
import { bridgeStoreEntry, bridgeGetEntry } from '../../memory/memory-bridge.js';

/** Must match ACCESS_FLUSH_INTERVAL_MS in bridge-entries.ts. */
const FLUSH_INTERVAL_MS = 30_000;

describe('access_count write throttle (#1402)', () => {
  let tempDir: string;
  let dbPath: string;
  let originalProjectDir: string | undefined;

  /** Reads the PERSISTED counter, bypassing the bridge cache entirely. */
  function persistedAccessCount(key: string): number {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = probe.prepare(
        'SELECT access_count FROM memory_entries WHERE key = ? AND namespace = ?',
      ).get(key, 'ns-1402') as { access_count: number } | undefined;
      return row ? Number(row.access_count) : -1;
    } finally {
      probe.close();
    }
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1402-'));
    fs.mkdirSync(path.join(tempDir, '.moflo'), { recursive: true });
    dbPath = path.join(tempDir, '.moflo', 'moflo.db');

    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tempDir;
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    await shutdownBridge();
    _resetProjectRootForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await shutdownBridge();
    _resetProjectRootForTest();
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('coalesces a burst of cache hits into a single write, losing no counts', async () => {
    await bridgeStoreEntry({ key: 'k', value: 'body', namespace: 'ns-1402', tags: ['t'], upsert: true });

    // First read flushes immediately (no prior stamp) and starts the interval.
    const first = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(first?.cacheHit).toBe(true);
    const afterFirst = persistedAccessCount('k');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);

    // Four more hits well inside the interval — none may write.
    for (let i = 0; i < 4; i++) {
      const r = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
      expect(r?.cacheHit).toBe(true);
    }
    expect(persistedAccessCount('k')).toBe(afterFirst);

    // Cross the interval; the next hit flushes all five deferred accesses
    // (the four above plus its own) in one write.
    vi.setSystemTime(Date.now() + FLUSH_INTERVAL_MS + 1);
    const sixth = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(sixth?.cacheHit).toBe(true);

    expect(persistedAccessCount('k')).toBe(afterFirst + 5);
  });

  it('increments the returned accessCount on every read regardless of flush timing', async () => {
    await bridgeStoreEntry({ key: 'k', value: 'body', namespace: 'ns-1402', tags: ['t'], upsert: true });

    const seen: number[] = [];
    const first = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    seen.push(first!.entry!.accessCount);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    for (let i = 0; i < 4; i++) {
      const r = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
      seen.push(r!.entry!.accessCount);
    }

    // Monotonic +1 per read — the #1396 guarantee, unaffected by throttling.
    expect(seen).toEqual([seen[0], seen[0] + 1, seen[0] + 2, seen[0] + 3, seen[0] + 4]);
  });

  it('never leaks throttle bookkeeping into the returned entry', async () => {
    await bridgeStoreEntry({ key: 'k', value: 'body', namespace: 'ns-1402', tags: ['t'], upsert: true });

    const hit = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(hit?.cacheHit).toBe(true);
    expect(Object.keys(hit!.entry!)).not.toContain('pendingAccessDelta');
    expect(Object.keys(hit!.entry!)).not.toContain('lastAccessFlushAt');

    // And on the disk path, which caches a separately-built record.
    await shutdownBridge();
    _resetProjectRootForTest();
    const miss = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(miss?.cacheHit).toBe(false);
    expect(Object.keys(miss!.entry!)).not.toContain('pendingAccessDelta');
    expect(Object.keys(miss!.entry!)).not.toContain('lastAccessFlushAt');
  });

  it('does not double-count the access a disk read already wrote', async () => {
    await bridgeStoreEntry({ key: 'k', value: 'body', namespace: 'ns-1402', tags: ['t'], upsert: true });

    // Drop the cache so the next read takes the disk path, which writes its own +1.
    await shutdownBridge();
    _resetProjectRootForTest();
    const fromDisk = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(fromDisk?.cacheHit).toBe(false);
    const afterDiskRead = persistedAccessCount('k');

    // A hit immediately after must NOT flush — the disk read just stamped the
    // interval. Without that stamp the delta would flush at once and the single
    // disk access would land in the column twice.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    const hit = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(hit?.cacheHit).toBe(true);
    expect(persistedAccessCount('k')).toBe(afterDiskRead);

    // After the interval it flushes exactly the deferred hits: the one above
    // plus the one crossing the boundary.
    vi.setSystemTime(Date.now() + FLUSH_INTERVAL_MS + 1);
    await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(persistedAccessCount('k')).toBe(afterDiskRead + 2);
  });

  it('loses no counts when the same key is read concurrently', async () => {
    // The neighbour fan-out issues parallel getEntry calls and two hits can
    // share an adjacent chunk key, so same-key concurrency is reachable on
    // exactly the workload this throttle exists for.
    //
    // If the delta were accumulated by rebuilding the cached record and writing
    // it back, both callers would read the same delta across the await boundary
    // and the second write would clobber the first — an access dropped
    // permanently, never reaching the DB. Mutating the shared cached object in
    // place makes the increment atomic under Node's single thread.
    await bridgeStoreEntry({ key: 'k', value: 'body', namespace: 'ns-1402', tags: [], upsert: true });

    // Prime the cache and stamp the interval so none of the parallel reads flush.
    await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    const baseline = persistedAccessCount('k');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);

    const PARALLEL = 20;
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => bridgeGetEntry({ key: 'k', namespace: 'ns-1402' })),
    );
    expect(results.every(r => r?.cacheHit === true)).toBe(true);
    expect(persistedAccessCount('k')).toBe(baseline); // still inside the interval

    // Every one of the 20 concurrent accesses must survive to the DB.
    vi.setSystemTime(Date.now() + FLUSH_INTERVAL_MS + 1);
    await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(persistedAccessCount('k')).toBe(baseline + PARALLEL + 1);
  });

  it('upgrade path: a cached record predating the throttle flushes rather than throwing', async () => {
    // An in-place upgrade cannot strand old-shape records (the L1 cache is
    // in-memory and the process restarts), but the read must still tolerate a
    // record with neither bookkeeping field — absent fields mean "never
    // flushed", which flushes immediately rather than deferring forever.
    await bridgeStoreEntry({ key: 'k', value: 'body', namespace: 'ns-1402', tags: ['t'], upsert: true });
    await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    const baseline = persistedAccessCount('k');

    const { getRegistry } = await import('../../memory/bridge-core.js');
    const registry = await getRegistry();
    const cache = registry?.get('tieredCache');
    expect(cache, 'tiered cache must be available for this test to mean anything').toBeTruthy();

    // A complete #1396-era record: full read shape, no throttle fields.
    // `TieredCacheManager.get` is async but hands back the stored object by
    // reference, so deleting here strips the live cached record — which is also
    // what makes the production in-place increment work.
    const current = await cache.get('entry:ns-1402:k');
    expect(current, 'cached record must be reachable').toBeTruthy();
    delete current.pendingAccessDelta;
    delete current.lastAccessFlushAt;

    const hit = await bridgeGetEntry({ key: 'k', namespace: 'ns-1402' });
    expect(hit?.cacheHit).toBe(true);
    expect(hit?.entry?.tags).toEqual(['t']);
    expect(persistedAccessCount('k')).toBe(baseline + 1);
  });

  it('throttles each key independently', async () => {
    await bridgeStoreEntry({ key: 'a', value: 'body a', namespace: 'ns-1402', tags: [], upsert: true });
    await bridgeStoreEntry({ key: 'b', value: 'body b', namespace: 'ns-1402', tags: [], upsert: true });

    await bridgeGetEntry({ key: 'a', namespace: 'ns-1402' });
    const aBaseline = persistedAccessCount('a');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);

    // `a` is inside its interval and must not write; `b` has never flushed, so
    // its first hit writes immediately. One key's throttle must not gate another.
    await bridgeGetEntry({ key: 'a', namespace: 'ns-1402' });
    expect(persistedAccessCount('a')).toBe(aBaseline);

    const bBefore = persistedAccessCount('b');
    await bridgeGetEntry({ key: 'b', namespace: 'ns-1402' });
    expect(persistedAccessCount('b')).toBe(bBefore + 1);
  });
});
