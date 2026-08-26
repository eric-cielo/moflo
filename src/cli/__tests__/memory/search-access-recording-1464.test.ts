/**
 * #1464 — `memory_search` records usage for the durable rows it returns.
 *
 * CLAUDE.md routes every prompt through `memory_search` before any other read,
 * so search IS the read path for learnings. Until this change nothing on that
 * path touched `access_count` / `last_accessed_at` — those moved only on
 * retrieve-by-key — so the most-consulted learning in the store looked
 * untouched since the day it was written, and `memory_cleanup`'s
 * `COALESCE(last_accessed_at, updated_at, created_at)` heuristic collapsed to
 * "old" for every row.
 *
 * The contract pinned here is the same one #1402 established for the entry
 * cache: **defer writes, never lose counts**, and never let the read path take
 * on an unbounded write obligation (#1058).
 *
 * Time is driven with `vi.setSystemTime`, never a real sleep — a 30s interval
 * tested by sleeping would be both slow and exactly the flakiness vector
 * CLAUDE.md's broken-window rule calls out.
 *
 * @module v3/cli/__tests__/memory/search-access-recording-1464
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { _resetProjectRootForTest, shutdownBridge } from '../../memory/bridge-core.js';
import { bridgeStoreEntry, bridgeSearchEntries } from '../../memory/memory-bridge.js';

/** Must match ACCESS_FLUSH_INTERVAL_MS in bridge-entries.ts. */
const FLUSH_INTERVAL_MS = 30_000;

/** Shared body so BM25 scores every seeded row against the same probe query. */
const BODY = 'reconcile durable learnings across worktrees';
const PROBE = 'reconcile durable learnings';

describe('search access recording (#1464)', () => {
  let tempDir: string;
  let dbPath: string;
  let originalProjectDir: string | undefined;

  /** Reads the PERSISTED counters, bypassing the bridge entirely. */
  function persisted(key: string, namespace: string): { count: number; accessedAt: number | null } {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = probe.prepare(
        'SELECT access_count, last_accessed_at FROM memory_entries WHERE key = ? AND namespace = ?',
      ).get(key, namespace) as { access_count: number; last_accessed_at: number | null } | undefined;
      if (!row) return { count: -1, accessedAt: null };
      return { count: Number(row.access_count), accessedAt: row.last_accessed_at };
    } finally {
      probe.close();
    }
  }

  async function search(namespace = 'all') {
    return bridgeSearchEntries({ query: PROBE, namespace, limit: 10, threshold: 0.01 });
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1464-'));
    fs.mkdirSync(path.join(tempDir, '.moflo'), { recursive: true });
    dbPath = path.join(tempDir, '.moflo', 'moflo.db');

    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tempDir;
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    // The throttle state is keyed by the database handle, so tearing the bridge
    // down here is also what gives each case a clean flush stamp — there is no
    // module-global to reset.
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

  async function seed(rows: Array<{ key: string; namespace: string }>): Promise<void> {
    for (const r of rows) {
      await bridgeStoreEntry({ key: r.key, value: BODY, namespace: r.namespace, upsert: true });
    }
  }

  it('advances access_count and last_accessed_at for a returned learnings row', async () => {
    await seed([{ key: 'decision', namespace: 'learnings' }]);
    expect(persisted('decision', 'learnings')).toEqual({ count: 0, accessedAt: null });

    const before = Date.now();
    const result = await search();
    expect(result?.results.some(r => r.key === 'decision')).toBe(true);

    const after = persisted('decision', 'learnings');
    expect(after.count).toBe(1);
    expect(after.accessedAt).not.toBeNull();
    expect(after.accessedAt!).toBeGreaterThanOrEqual(before);
  });

  it('records the knowledge namespace too, and leaves structural namespaces alone', async () => {
    await seed([
      { key: 'fact', namespace: 'knowledge' },
      { key: 'chunk', namespace: 'code-map' },
    ]);

    const result = await search();
    // Both rows must actually come back, or "not recorded" would be vacuous.
    expect(result?.results.map(r => r.key).sort()).toEqual(['chunk', 'fact']);

    expect(persisted('fact', 'knowledge').count).toBe(1);
    // Structural namespaces are re-indexed wholesale; their usage counts are
    // noise, and paying a write for them would tax the hot path for nothing.
    expect(persisted('chunk', 'code-map')).toEqual({ count: 0, accessedAt: null });
  });

  it('coalesces a burst of searches into a single write, losing no counts', async () => {
    await seed([{ key: 'decision', namespace: 'learnings' }]);

    // First search flushes immediately (this process has never flushed) and
    // starts the interval.
    await search();
    expect(persisted('decision', 'learnings').count).toBe(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);

    // Four more searches well inside the interval — none may write. This is the
    // throttle assertion: the hot path must not issue a write per hit.
    for (let i = 0; i < 4; i++) await search();
    expect(persisted('decision', 'learnings').count).toBe(1);

    // Cross the interval; the next search flushes all five deferred accesses
    // (the four above plus its own) in one write.
    vi.setSystemTime(Date.now() + FLUSH_INTERVAL_MS + 1);
    await search();
    expect(persisted('decision', 'learnings').count).toBe(6);
  });

  it('flushes every durable row of a result set in one pass', async () => {
    await seed([
      { key: 'a', namespace: 'learnings' },
      { key: 'b', namespace: 'learnings' },
      { key: 'c', namespace: 'knowledge' },
    ]);

    await search();

    expect(persisted('a', 'learnings').count).toBe(1);
    expect(persisted('b', 'learnings').count).toBe(1);
    expect(persisted('c', 'knowledge').count).toBe(1);
  });

  it('never flushes one database\'s pending deltas into another', async () => {
    // The deltas are entry ids, which only mean anything inside the store that
    // issued them. Held module-globally they would be flushed against whatever
    // database this process reached next — matching no row there, then cleared
    // as though written. That is a silent loss of exactly the counts this
    // feature exists to record.
    await seed([{ key: 'decision', namespace: 'learnings' }]);
    await search();
    expect(persisted('decision', 'learnings').count).toBe(1);

    // Accumulate a delta that is deliberately left unflushed.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    await search();
    expect(persisted('decision', 'learnings').count).toBe(1);

    // A second store, reached by the same process well past the interval.
    const otherDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1464-other-'));
    try {
      fs.mkdirSync(path.join(otherDir, '.moflo'), { recursive: true });
      vi.setSystemTime(Date.now() + FLUSH_INTERVAL_MS + 1);
      process.env.CLAUDE_PROJECT_DIR = otherDir;
      await shutdownBridge();
      _resetProjectRootForTest();

      await bridgeStoreEntry({ key: 'elsewhere', value: BODY, namespace: 'learnings', upsert: true });
      await search();

      // The other store recorded its own row, and the first store's pending
      // delta was never spent against it.
      const otherDb = new DatabaseSync(path.join(otherDir, '.moflo', 'moflo.db'), { readOnly: true });
      try {
        const row = otherDb.prepare(
          'SELECT access_count FROM memory_entries WHERE key = ?',
        ).get('elsewhere') as { access_count: number };
        expect(Number(row.access_count)).toBe(1);
      } finally {
        otherDb.close();
      }
    } finally {
      vi.useRealTimers();
      process.env.CLAUDE_PROJECT_DIR = tempDir;
      await shutdownBridge();
      _resetProjectRootForTest();
      fs.rmSync(otherDir, { recursive: true, force: true });
    }

    // Back at the first store, on a bridge handle rebuilt from scratch. Its one
    // unflushed delta died with the old handle — the same bounded residual
    // #1402 documents for a cache eviction, and the deliberate trade against
    // spending it on a store where it means nothing. The new handle has never
    // flushed, so this search writes immediately: 1 (first search) + 1 (this
    // one) = 2. Held module-globally the count would instead read 1, because
    // the flush against the other database would have cleared the delta and
    // left a flush stamp in the future.
    await search();
    expect(persisted('decision', 'learnings').count).toBe(2);
  });

  it('skips the bookkeeping entirely for a namespace-scoped structural search', async () => {
    await seed([
      { key: 'chunk', namespace: 'code-map' },
      { key: 'decision', namespace: 'learnings' },
    ]);

    const result = await search('code-map');
    expect(result?.results.map(r => r.key)).toEqual(['chunk']);

    expect(persisted('chunk', 'code-map').count).toBe(0);
    // The durable row was never in this result set, so it must be untouched —
    // and the flush stamp must not have been spent on an empty pass either.
    expect(persisted('decision', 'learnings').count).toBe(0);

    await search('learnings');
    expect(persisted('decision', 'learnings').count).toBe(1);
  });
});

describe('#1058 regression guard — the read path never writes back a whole-DB snapshot', () => {
  /**
   * Read a source file with its comments removed.
   *
   * The banned shapes are named verbatim in the very comments that explain why
   * they are banned — `entries-read.ts` documents the `atomicWriteFileSync(dbPath,
   * db.export())` it deleted. Matching raw text would force those explanations
   * out of the codebase to keep the guard green, which is backwards: the rule is
   * about executable code, so strip prose before matching rather than weaken the
   * pattern or carve out an exemption.
   *
   * Block comments go first; then any line that is *entirely* a `//` comment —
   * never a trailing one, so a `//` inside a string literal is left alone.
   */
  const read = (rel: string): string =>
    fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n');

  it('entries-read.ts issues no db.export() writeback', () => {
    const src = read('../../memory/entries-read.ts');
    // #1058: this path used to `UPDATE access_count` and then dump the entire
    // DB back to disk, clobbering anything another process wrote in between.
    // #1464 restores the counter bump — it must never restore the dump with it.
    expect(src).not.toMatch(/\.export\(\)/);
    expect(src).not.toMatch(/atomicWriteFileSync/);
  });

  it('bridgeSearchEntries issues no whole-DB persist', () => {
    const src = read('../../memory/bridge-entries.ts');
    const start = src.indexOf('export async function bridgeSearchEntries');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nexport ', start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);

    expect(body).not.toMatch(/\.export\(\)/);
    expect(body).not.toMatch(/persistBridgeDb|tryPersist|atomicWriteFileSync/);
    // What it MAY do is a bounded per-row UPDATE via the throttle.
    expect(body).toMatch(/recordSearchAccess\(/);
  });

  it('the search access flush is a bounded UPDATE, not a snapshot', () => {
    const src = read('../../memory/bridge-entries.ts');
    const start = src.indexOf('function recordSearchAccess');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nexport function serialiseMetadata', start));

    // The statement it issues is shared with the entry-cache throttle and adds
    // a delta to one row by id — bounded work, whatever the store's size.
    expect(body).toMatch(/ACCESS_BUMP_SQL/);
    expect(src).toMatch(
      /const ACCESS_BUMP_SQL =\s*`UPDATE memory_entries SET access_count = access_count \+ \?/,
    );
    expect(body).not.toMatch(/\.export\(\)|persistBridgeDb|atomicWriteFileSync/);
  });
});
