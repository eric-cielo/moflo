/**
 * Bridge entries store — CLI-facing memory_entries operations.
 *
 * This is the sql.js `memory_entries` table the bridge owns directly
 * (not a moflo controller table). Separated out of memory-bridge.ts
 * to keep the top-level bridge a thin controller-op wrapper.
 *
 * @module v3/cli/bridge-entries
 */

import { cosineSim, execRows, generateId, logBridgeError, persistBridgeDb, refreshVectorStatsCache, searchCandidateCap, withDb } from './bridge-core.js';
import { embeddingResponseFrom, getBridgeEmbedder, resolveBridgeEmbedding } from './bridge-embedder.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import { archiveDurableRow, isDurableNamespace } from '../services/durable-store-io.js';
import type { SqlJsLikeDatabase } from './daemon-backend.js';

/**
 * Run `persistBridgeDb` and convert any throw into a `persist failed:`
 * error string for the caller. Centralises the #982 single-store /
 * bulk-store / delete pattern so the failure shape can never drift
 * across the three call sites.
 */
function tryPersist(db: any, dbPath?: string): { ok: true } | { ok: false; error: string } {
  try {
    persistBridgeDb(db, dbPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `persist failed: ${errorDetail(err)}` };
  }
}

function makeEntryCacheKey(namespace: string, key: string): string {
  const safeNs = String(namespace).replace(/:/g, '_');
  const safeKey = String(key).replace(/:/g, '_');
  return `entry:${safeNs}:${safeKey}`;
}

/**
 * The canonical shape of an entry-cache value — identical to what
 * {@link bridgeGetEntry} returns, because a cache hit returns it verbatim.
 *
 * #1396: every writer that warms this cache MUST produce the full shape. An
 * omitted field is not merely absent on read — the cache-hit branch substitutes
 * a *default that reads as real data*: `tags: []`, `accessCount: 0`, and
 * timestamps defaulting to "now", i.e. RETRIEVAL time. The store paths warmed
 * the cache with `{id,key,namespace,content,embedding,metadata}` only, so for
 * the cache's 5-minute TTL after any write, `memory_retrieve` reported a row
 * with no tags, a zero access count, and a `storedAt` equal to the moment it
 * was read. The row on disk was correct throughout — the loss was read-side and
 * temporary, never a failed write.
 *
 * `metadata` was added to the store-path cache value by #1064 for exactly this
 * reason; the remaining fields were not, which is why metadata survived and
 * tags did not. `cacheSet` takes this type rather than `any`, so the next field
 * added to the read shape cannot be half-wired the same way — an incomplete
 * writer is a compile error rather than a silent read-side fabrication.
 */
interface CachedEntry {
  id: string;
  key: string;
  namespace: string;
  content: string;
  accessCount: number;
  /** Epoch ms, as stored on disk — not an ISO string. */
  createdAt: number | string;
  updatedAt: number | string;
  hasEmbedding: boolean;
  tags: string[];
  metadata?: string;
}

/**
 * What actually goes into the cache: the returned entry plus access-throttle
 * bookkeeping (#1402).
 *
 * These two fields MUST NOT reach a caller. `bridgeGetEntry` builds the returned
 * `CachedEntry` separately and spreads it into the record, so `memory_retrieve`
 * and `memory_get_neighbors` never see them.
 */
interface CachedEntryRecord extends CachedEntry {
  /** Cache hits counted for this key since the last `access_count` flush. */
  pendingAccessDelta?: number;
  /** Epoch ms of the last `access_count` write for this key. */
  lastAccessFlushAt?: number;
}

/**
 * Minimum gap between `access_count` writes for a single key (#1402).
 *
 * #1396 made a cache hit bump `access_count`, which is correct — the counter
 * feeds `sortBy('accessCount')` and stats, so a row read repeatedly inside the
 * cache TTL must not look untouched. But `bridgeGetEntry` is called in fan-out
 * loops, not once per user retrieve: the dashboard's `/api/schedules` and
 * `/api/spells` handlers issue up to 300 `getEntry` calls between them, and the
 * browser polls both every 5s — ~60 writes/sec against the same hot keys, where
 * before the fix it was zero I/O.
 *
 * A global debounce timer would need a flush-on-exit hook, and moflo's
 * short-lived CLI processes would silently drop counts on exit — the same
 * "observability that quietly lies" failure #1396 existed to remove. Throttling
 * per key needs no timer and no exit hook: the delta rides on the cached record
 * itself, which every hit already touches.
 *
 * KNOWN RESIDUAL — not lossless, and deliberately so. If the cache evicts a
 * record (5-minute TTL, or LRU at 10k entries) while its delta is unflushed,
 * those accesses are gone; likewise a process crash mid-interval. Draining on
 * eviction would mean issuing async DB work from `CacheManager.evictLRU`, a
 * synchronous path in a different module — real blast radius on the memory
 * chokepoint to recover at most one interval's counts for a key that, by virtue
 * of being evicted, is not in a hot read loop. The keys this throttle exists
 * for flush every interval, well inside the TTL. `access_count` feeds ordering
 * and stats, not accounting, so a bounded undercount on cold keys is the right
 * trade; a systematic undercount of HOT keys — the #1396 defect — is not.
 */
const ACCESS_FLUSH_INTERVAL_MS = 30_000;

/**
 * The access bump, shared by the two throttles that issue it. Adding the
 * accumulated delta in SQL — rather than writing a client-computed absolute —
 * is what keeps the counter correct under concurrency, so the statement is
 * written once and reused rather than retyped per call site.
 */
const ACCESS_BUMP_SQL =
  `UPDATE memory_entries SET access_count = access_count + ?, last_accessed_at = ? WHERE id = ?`;

/** Deferred access deltas for one database handle. */
interface SearchAccessState {
  /** Entry id → accesses recorded but not yet written. */
  deltas: Map<string, number>;
  lastFlushAt: number;
}

/**
 * Deferred `access_count` deltas for rows returned by SEARCH, per database.
 *
 * #1464 — `memory_search` is the read path for durable learnings (CLAUDE.md
 * routes every prompt through it before any other read), but nothing on that
 * path recorded usage: `access_count` / `last_accessed_at` moved only on
 * retrieve-by-key. The most-consulted learning in the store looked untouched
 * since the day it was written, which in turn made every age-based cleanup
 * heuristic a guess dressed up as a measurement.
 *
 * Scoped to DURABLE namespaces on purpose. Structural namespaces (code-map,
 * patterns, tests) are re-indexed wholesale on a schedule and their usage
 * counts are noise — paying a write for them would tax the hot path to record
 * nothing anyone reads.
 *
 * KEYED BY THE DATABASE HANDLE, not module-global. Entry ids are only
 * meaningful inside the store that issued them, so a process that reaches a
 * second database — a `dbPath` override, or a bridge rebuilt against a
 * different project root — must not carry the first one's deltas across.
 * Module-global state would flush ids that match nothing in the new store and
 * then clear them, silently discarding counts against the "defer, never lose"
 * rule below. A WeakMap also means a torn-down bridge's state is collected with
 * its handle rather than accumulating for the life of the daemon, and each test
 * gets clean state from its own database with no reset hook to remember.
 *
 * Same trade as the per-key entry-cache throttle below: defer writes, never
 * lose counts. The flush stamp is per DATABASE rather than per key because a
 * search touches a whole result set at once — the unit being coalesced here is
 * the search, not the key.
 */
const searchAccessByDb = new WeakMap<SqlJsLikeDatabase, SearchAccessState>();

/**
 * Hard bound on one database's pending deltas. Durable namespaces are small, so
 * this is a backstop rather than a working limit — but an unbounded map inside
 * a daemon that lives for days is a leak regardless of how unlikely it is to
 * fill. Reaching the cap forces a flush; it never drops deltas.
 */
const SEARCH_ACCESS_PENDING_CAP = 1_000;

/**
 * Accumulate one access per returned durable row, flushing at most once per
 * {@link ACCESS_FLUSH_INTERVAL_MS}.
 *
 * `ids` are already filtered to durable rows by the caller, which is also where
 * the per-row namespace test happens — a structural hit never reaches this map.
 * Call with an empty array to give a pending set its chance to flush.
 *
 * Best-effort by construction: a throw leaves the deltas pending for the next
 * attempt and search results are returned either way. Usage is observability,
 * not correctness — #1058 is the standing proof of what happens when the read
 * path takes on a write obligation it cannot honour safely. What it issues is a
 * bounded per-row UPDATE, never the whole-DB `db.export()` writeback that
 * clobbered concurrent writers.
 */
function recordSearchAccess(
  db: SqlJsLikeDatabase,
  ids: ReadonlyArray<string>,
  now: number,
): void {
  let state = searchAccessByDb.get(db);
  if (!state) {
    // Nothing to record and nothing pending — don't allocate state for a
    // database whose searches never return a durable row.
    if (ids.length === 0) return;
    state = { deltas: new Map(), lastFlushAt: 0 };
    searchAccessByDb.set(db, state);
  }

  for (const id of ids) state.deltas.set(id, (state.deltas.get(id) ?? 0) + 1);
  if (state.deltas.size === 0) return;

  // A database this process has never flushed writes immediately rather than
  // waiting out the interval — moflo's CLI processes are short-lived and would
  // otherwise exit with every access still pending, reintroducing the silent
  // undercount this exists to remove.
  const forced = state.deltas.size >= SEARCH_ACCESS_PENDING_CAP;
  if (!forced && now - state.lastFlushAt < ACCESS_FLUSH_INTERVAL_MS) return;

  try {
    const stmt = db.prepare(ACCESS_BUMP_SQL);
    db.run('BEGIN');
    try {
      for (const [id, delta] of state.deltas) stmt.run([delta, now, id]);
      db.run('COMMIT');
    } catch (err) {
      try { db.run('ROLLBACK'); } catch { /* a failed COMMIT already ended the txn */ }
      throw err;
    }
    // Clear ONLY after the commit lands. Clearing on a throw would discard the
    // accumulated hits outright — the throttle defers writes, it does not drop
    // them.
    state.deltas.clear();
    state.lastFlushAt = now;
  } catch (err) {
    logBridgeError('search access flush failed', err);
  }
}

/** Normalise `metadata` for the `metadata` TEXT column; `undefined` → `'{}'` (#1064). */
export function serialiseMetadata(metadata: Record<string, unknown> | string | undefined): string {
  if (metadata == null) return '{}';
  if (typeof metadata === 'string') return metadata;
  try { return JSON.stringify(metadata); }
  catch { return '{}'; }
}

function bm25Score(
  queryTerms: string[],
  docContent: string,
  avgDocLength: number,
  docCount: number,
  termDocFreqs: Map<string, number>,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const docWords = docContent.toLowerCase().split(/\s+/);
  const docLength = docWords.length;

  let score = 0;
  for (const term of queryTerms) {
    const tf = docWords.filter(w => w === term || w.includes(term)).length;
    if (tf === 0) continue;

    const df = termDocFreqs.get(term) || 1;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / Math.max(1, avgDocLength))));
    score += idf * tfNorm;
  }

  return score;
}

function computeTermDocFreqs(
  queryTerms: string[],
  rows: Array<{ content?: unknown }>,
): { termDocFreqs: Map<string, number>; avgDocLength: number } {
  const termDocFreqs = new Map<string, number>();
  let totalLength = 0;

  for (const row of rows) {
    const content = String(row.content || '').toLowerCase();
    const words = content.split(/\s+/);
    totalLength += words.length;

    for (const term of queryTerms) {
      if (content.includes(term)) {
        termDocFreqs.set(term, (termDocFreqs.get(term) || 0) + 1);
      }
    }
  }

  return { termDocFreqs, avgDocLength: rows.length > 0 ? totalLength / rows.length : 1 };
}

async function cacheGet(registry: any, cacheKey: string): Promise<any | null> {
  const cache = registry.get('tieredCache');
  if (!cache) return null;
  return (await cache.get(cacheKey)) ?? null;
}

/** Typed on purpose (#1396) — a partial cache value is a compile error, not a silent read-side data loss. */
async function cacheSet(registry: any, cacheKey: string, value: CachedEntryRecord): Promise<void> {
  const cache = registry.get('tieredCache');
  if (!cache) return;
  await cache.set(cacheKey, value);
}

async function cacheInvalidate(registry: any, cacheKey: string): Promise<void> {
  const cache = registry.get('tieredCache');
  if (!cache) return;
  cache.delete(cacheKey);
}

/**
 * Opaque handle returned by {@link guardValidate} when the mutation passes
 * MutationGuard's checks. Callers commit it via {@link guardCommit} AFTER
 * the corresponding write succeeds; on failure the handle is discarded and
 * MutationGuard's dedupe buffer stays clean — critical for withDb's
 * SQLITE_BUSY retry path (#1098), where a failed write must not leave a
 * stale recording that rejects the retry as a "duplicate".
 */
type GuardCommit = { guard: any; token: any } | null;

async function guardValidate(
  registry: any,
  operation: string,
  params: Record<string, unknown>,
  options?: { bypassDedupe?: boolean },
): Promise<{ allowed: boolean; reason?: string; commit: GuardCommit }> {
  const guard = registry.get('mutationGuard');
  if (!guard) return { allowed: true, commit: null };
  const result = guard.validate({ operation, params, timestamp: Date.now(), bypassDedupe: options?.bypassDedupe });
  const allowed = result?.allowed === true;
  return {
    allowed,
    reason: result?.reason,
    commit: allowed && result?.token ? { guard, token: result.token } : null,
  };
}

/**
 * Confirm a previously-validated mutation. Idempotent and null-safe so
 * call sites can fire it from a `finally`-style success branch without
 * extra null checking. After commit, the mutation lands in MutationGuard's
 * dedupe buffer so subsequent identical writes within the window are
 * correctly rejected.
 */
function guardCommit(handle: GuardCommit): void {
  if (!handle) return;
  try { handle.guard.commit(handle.token); }
  catch { /* commit failure is non-fatal — recording is observability-grade */ }
}

async function logAttestation(
  registry: any,
  operation: string,
  entryId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const attestation = registry.get('attestationLog');
  if (!attestation) return;
  try {
    attestation.record({ operation, entryId, timestamp: Date.now(), ...metadata });
  } catch {
    // Non-fatal — attestation is observability, not correctness
  }
}

/**
 * Store an entry. Returns null to signal fallback to sql.js.
 *
 * `precomputedEmbedding`: skip the live `embedder.embed()` and use a vector
 * the caller already computed. Still labelled with the live embedder's
 * `model` so downstream consumers can't tell the difference.
 */
export async function bridgeStoreEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  precomputedEmbedding?: Float32Array | number[];
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
  /** Per-row JSON for the `metadata` TEXT column; chunk-shaped rows need this so #1064 producers stop bypassing the chokepoint. */
  metadata?: Record<string, unknown> | string;
}): Promise<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  guarded?: boolean;
  cached?: boolean;
  attested?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, value, namespace = 'default', tags = [], ttl } = options;
    const id = generateId('entry');
    const now = Date.now();

    const guardResult = await guardValidate(registry, 'store', { key, namespace, size: value.length });
    if (!guardResult.allowed) {
      // Dedupe rejection means the same `(op, params)` write just succeeded
      // — the caller's data is already durable. Look up the existing row so
      // we can return its id with success:true; this matches what the
      // dedupe semantically means (a no-op, not a failure). Other rejection
      // reasons (rate limit, etc.) remain real failures. Match the literal
      // reason string rather than a substring regex so a future rejection
      // worded with "duplicate mutation" but different semantics doesn't
      // get silently swallowed.
      if (guardResult.reason === 'duplicate mutation within dedupe window') {
        let existingId: string | null = null;
        const probe = ctx.db.prepare(
          `SELECT id FROM memory_entries WHERE namespace = ? AND key = ? AND status = 'active' LIMIT 1`,
        );
        try {
          probe.bind([namespace, key]);
          if (probe.step()) {
            existingId = String((probe.getAsObject() as { id: string }).id);
          }
        } finally {
          probe.free();
        }
        if (existingId) {
          return { success: true, id: existingId };
        }
      }
      return { success: false, id, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    const resolved = await resolveBridgeEmbedding(value, options.precomputedEmbedding, options.generateEmbeddingFlag, namespace);
    if (!resolved.ok) {
      return { success: false, id, error: `embedding generation failed: ${resolved.reason}` };
    }
    const { json: embeddingJson, dimensions, model } = resolved;
    const embeddingResponse = embeddingResponseFrom(resolved);

    // Idempotency guard, mirrors the one in `memory-initializer.ts`'s raw-
    // sql.js fallback. When the daemon route just wrote this exact row but
    // the client missed the ack, we land here with the row already on disk;
    // a plain INSERT would trip UNIQUE and surface as `[moflo] bridge
    // operation failed:` stderr noise even though the data is durable.
    // Probe first so withDb never sees the throw.
    //
    // Limitations carried forward: only `content` is compared, not `tags`
    // or `ttl`. The targeted scenario is the same caller's request being
    // processed twice (daemon write + client retry), where every option is
    // identical by definition — a different caller varying `tags` after a
    // missed-ack would still see this as an idempotent no-op rather than
    // an update. `cached: false, attested: false` because the prior writer
    // already ran post-persist bookkeeping; this process's in-memory cache
    // stays cold for one retrieve until the read path warms it (perf only,
    // not correctness).
    if (!options.upsert) {
      let existingId: string | null = null;
      let existingContent: string | null = null;
      const probe = ctx.db.prepare(
        `SELECT id, content FROM memory_entries WHERE namespace = ? AND key = ? AND status = 'active' LIMIT 1`,
      );
      try {
        probe.bind([namespace, key]);
        if (probe.step()) {
          const row = probe.getAsObject() as { id: string; content: string };
          existingId = String(row.id);
          existingContent = row.content;
        }
      } finally {
        probe.free();
      }
      if (existingId && existingContent === value) {
        return {
          success: true,
          id: existingId,
          embedding: embeddingResponse,
          guarded: true,
          cached: false,
          attested: false,
        };
      }
    }

    const insertSql = options.upsert
      ? `INSERT OR REPLACE INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      : `INSERT INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`;

    // sql.js Statement.run takes an array of bindings — not varargs.
    const metadataJson = serialiseMetadata(options.metadata);
    const stmt = ctx.db.prepare(insertSql);
    stmt.run([
      id, key, namespace, value,
      embeddingJson, dimensions || null, model,
      tags.length > 0 ? JSON.stringify(tags) : null,
      metadataJson,
      now, now,
      ttl ? now + (ttl * 1000) : null,
    ]);

    // Honest persist (#982). If atomicWriteFileSync throws (Windows EBUSY
    // on a daemon-held file, ENOSPC, perm denied, antivirus rename block),
    // surface it as `success: false` instead of returning a lying success.
    // Skip post-persist bookkeeping so cache + attestation cannot diverge
    // from on-disk state.
    const persisted = tryPersist(ctx.db, options.dbPath);
    if (!persisted.ok) {
      return { success: false, id, error: persisted.error };
    }

    // Post-persist bookkeeping (#994). The row is durable on disk; cache
    // warming, attestation, and statusline stats are observability only.
    // A throw here MUST NOT propagate — withDb would catch it, return null,
    // and storeEntry would fall back to raw sql.js, which then fails with
    // UNIQUE constraint (the bridge already wrote the row) and reports
    // exit 1 even though `memory retrieve` finds the value moments later.
    // Same #982 invariant in the inverse direction.
    const cacheKey = makeEntryCacheKey(namespace, key);
    let cached = true;
    try {
      // #1064 — include metadata in the cache value so a subsequent
      // bridgeGetEntry cache-hit returns the same shape as a fresh disk read.
      // Without this, chunk-row producers writing through the chokepoint would
      // get `{}` back from cache and the full metadata from disk — exactly the
      // divergence the cache is supposed to mask.
      //
      // #1396 — and the same argument applies to every other column the reader
      // returns. Warm the FULL CachedEntry shape, not just the embedding and
      // metadata, or a retrieve inside the cache TTL reports empty tags, a zero
      // access count, and a storedAt of "now".
      await cacheSet(registry, cacheKey, {
        id, key, namespace, content: value,
        accessCount: 0,
        createdAt: now,
        updatedAt: now,
        hasEmbedding: !!embeddingJson,
        tags,
        metadata: metadataJson,
      });
    } catch (err) {
      cached = false;
      logBridgeError('post-persist cache set failed', err);
    }

    // logAttestation already swallows internally; the await catches any
    // pre-call registry-resolution throw too. Logged so a recurring failure
    // is visible without crashing the write path.
    try {
      await logAttestation(registry, 'store', id, { key, namespace, hasEmbedding: !!embeddingJson });
    } catch (err) {
      logBridgeError('post-persist attestation failed', err);
    }

    if (embeddingJson) {
      try { refreshVectorStatsCache(); }
      catch (err) { logBridgeError('post-persist stats refresh failed', err); }
    }

    // Commit the MutationGuard recording NOW that the row is durable on
    // disk + cache + attestation log. Order: persist before commit so a
    // SQLITE_BUSY mid-write doesn't leave a stale dedupe entry that would
    // reject the withDb retry as a "duplicate" (#1098).
    guardCommit(guardResult.commit);

    return {
      success: true,
      id,
      embedding: embeddingResponse,
      guarded: true,
      cached,
      attested: true,
    };
  });
}

/**
 * Bulk-store entries inside a single bridge session and persist the DB once
 * at the end. Per-item failures are reported in the returned array; one bad
 * item never aborts the rest. Returns null when the bridge is unavailable.
 */
export async function bridgeStoreEntries(items: Array<{
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  precomputedEmbedding?: Float32Array | number[];
  tags?: string[];
  ttl?: number;
  upsert?: boolean;
  /** Per-item metadata. See {@link bridgeStoreEntry} for the shape contract. */
  metadata?: Record<string, unknown> | string;
}>, dbPath?: string): Promise<Array<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  error?: string;
}> | null> {
  if (items.length === 0) return [];
  return withDb(dbPath, async (ctx, registry) => {
    const results: Array<{ success: boolean; id: string; embedding?: { dimensions: number; model: string }; error?: string }> = [];
    /**
     * Per-item bookkeeping fired AFTER persist succeeds (#982). If we
     * fired cache/attestation during the loop and then persist threw,
     * the cache would be warm with rows that never reached disk — the
     * exact divergence #982 is fixing in the single-store path. Defer.
     */
    const deferredBookkeeping: Array<{ cacheKey: string; cacheValue: CachedEntry; entryId: string; entryKey: string; namespace: string; hasEmbedding: boolean }> = [];
    let anyEmbedded = false;
    let anyWritten = false;

    // Validate the batch once as a single 'bulk-store' mutation. Per-item
    // 'store' validation would burn the 50/s rate budget on what the caller
    // intends as one operation — pretrain's 56 patterns would trip the limit
    // halfway through. Upsert batches set bypassDedupe because identical
    // back-to-back upserts are intentional refresh, not accidental dups.
    const totalSize = items.reduce((acc, it) => acc + it.value.length, 0);
    const allUpsert = items.every(it => it.upsert === true);
    const guardResult = await guardValidate(
      registry,
      'bulk-store',
      {
        count: items.length,
        size: totalSize,
        namespaces: Array.from(new Set(items.map(it => it.namespace ?? 'default'))),
      },
      { bypassDedupe: allUpsert },
    );
    if (!guardResult.allowed) {
      const reason = `MutationGuard rejected bulk-store: ${guardResult.reason}`;
      return items.map(() => ({ success: false, id: generateId('entry'), error: reason }));
    }

    for (const opts of items) {
      const { key, value, namespace = 'default', tags = [], ttl } = opts;
      const id = generateId('entry');
      const now = Date.now();

      const resolved = await resolveBridgeEmbedding(value, opts.precomputedEmbedding, opts.generateEmbeddingFlag, namespace);
      if (!resolved.ok) {
        results.push({ success: false, id, error: `embedding generation failed: ${resolved.reason}` });
        continue;
      }
      const { json: embeddingJson, dimensions, model } = resolved;
      const embeddingResponse = embeddingResponseFrom(resolved);

      const insertSql = opts.upsert
        ? `INSERT OR REPLACE INTO memory_entries (
            id, key, namespace, content, type,
            embedding, embedding_dimensions, embedding_model,
            tags, metadata, created_at, updated_at, expires_at, status
          ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        : `INSERT INTO memory_entries (
            id, key, namespace, content, type,
            embedding, embedding_dimensions, embedding_model,
            tags, metadata, created_at, updated_at, expires_at, status
          ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`;

      const metadataJson = serialiseMetadata(opts.metadata);
      try {
        const stmt = ctx.db.prepare(insertSql);
        stmt.run([
          id, key, namespace, value,
          embeddingJson, dimensions || null, model,
          tags.length > 0 ? JSON.stringify(tags) : null,
          metadataJson,
          now, now,
          ttl ? now + (ttl * 1000) : null,
        ]);
      } catch (err) {
        const reason = errorDetail(err);
        results.push({ success: false, id, error: `insert failed: ${reason}` });
        continue;
      }
      anyWritten = true;
      if (embeddingJson) anyEmbedded = true;

      deferredBookkeeping.push({
        cacheKey: makeEntryCacheKey(namespace, key),
        // #1064 / #1396 — keep cache shape in sync with disk (see single-store path).
        cacheValue: {
          id, key, namespace, content: value,
          accessCount: 0,
          createdAt: now,
          updatedAt: now,
          hasEmbedding: !!embeddingJson,
          tags,
          metadata: metadataJson,
        },
        entryId: id,
        entryKey: key,
        namespace,
        hasEmbedding: !!embeddingJson,
      });

      results.push({
        success: true,
        id,
        embedding: embeddingResponse,
      });
    }

    // Honest persist (#982). The whole batch shares one persist call: if it
    // throws, NONE of the rows reached disk, so flip every successful entry
    // to a failure with the same error. Per-row partial success is impossible
    // — sql.js dumps the entire DB snapshot atomically. Bookkeeping (cache
    // + attestation) is deferred until AFTER persist succeeds so the cache
    // cannot warm rows that never reached disk.
    if (anyWritten) {
      const persisted = tryPersist(ctx.db, dbPath);
      if (!persisted.ok) {
        for (let i = 0; i < results.length; i++) {
          if (results[i].success) {
            results[i] = { success: false, id: results[i].id, error: persisted.error };
          }
        }
        return results;
      }
    }

    // Persist succeeded — fire deferred bookkeeping in parallel.
    // Wrapped in try/catch (#994): rows are already durable, so a cache or
    // attestation throw must not propagate to withDb's catch and downgrade
    // every successful row to a fallback retry that fails on UNIQUE.
    // Promise.all short-circuits, so partial bookkeeping is silently lost
    // on a throw — log so a recurring failure is debuggable.
    try {
      await Promise.all(
        deferredBookkeeping.flatMap(b => [
          cacheSet(registry, b.cacheKey, b.cacheValue),
          logAttestation(registry, 'store', b.entryId, { key: b.entryKey, namespace: b.namespace, hasEmbedding: b.hasEmbedding }),
        ]),
      );
    } catch (err) {
      logBridgeError('post-persist batch bookkeeping failed', err);
    }
    if (anyEmbedded) {
      try { refreshVectorStatsCache(); }
      catch (err) { logBridgeError('post-persist stats refresh failed', err); }
    }

    // Commit the bulk-store mutation in the dedupe buffer (#1098). At least
    // one row reached disk, which is sufficient to record the bulk op —
    // partial-batch persist failure is already reflected per-item via the
    // results array.
    guardCommit(guardResult.commit);

    return results;
  });
}

/**
 * Search entries with hybrid BM25 + cosine scoring.
 */
export async function bridgeSearchEntries(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  results: {
    id: string;
    key: string;
    content: string;
    score: number;
    namespace: string;
    provenance?: string;
    metadata?: string;
  }[];
  searchTime: number;
  searchMethod?: string;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx) => {
    const { query: queryStr, namespace = 'default', limit = 10, threshold = 0.3 } = options;
    const startTime = Date.now();

    const nsFilter = namespace !== 'all' ? `AND namespace = ?` : '';

    let rows: Record<string, unknown>[];
    try {
      // #1201 — ORDER BY created_at DESC before the cap. A bare `LIMIT 1000`
      // (no ORDER BY) truncated the candidate pool by rowid, so on a populated
      // DB the first 1000 rows were all bulk-indexed code-map and a
      // no-namespace search never scored learnings/patterns/etc. Recency
      // ordering keeps recent curated entries in the pool when truncation hits.
      const sql = `
        SELECT id, key, namespace, content, metadata, embedding
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        ORDER BY created_at DESC
        LIMIT ${searchCandidateCap()}
      `;
      rows = namespace !== 'all' ? execRows(ctx.db, sql, [namespace]) : execRows(ctx.db, sql);
    } catch {
      return null;
    }

    // Skip the embed call when there's nothing to score against — fastembed
    // is the dominant cost in this function (~50–200ms cold).
    if (rows.length === 0) {
      return { success: true, results: [], searchTime: Date.now() - startTime };
    }

    // ctx.mofloDb only carries { database, close } — `embedder` was always
    // undefined here, silently dropping search to BM25-only and missing
    // semantically-related rows (#837). Use the bridge embedder directly so
    // the read path mirrors the write path. Same fix #648 applied to
    // bridgeGenerateEmbedding.
    let queryEmbedding: number[] | null = null;
    try {
      const embedder = getBridgeEmbedder();
      const emb = await embedder.embed(queryStr);
      queryEmbedding = Array.from(emb);
    } catch {
      // Fall back to keyword search
    }

    const queryTerms = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const { termDocFreqs, avgDocLength } = computeTermDocFreqs(queryTerms, rows);
    const docCount = rows.length;

    const results: { id: string; key: string; content: string; score: number; namespace: string; provenance?: string; metadata?: string }[] = [];

    // #1464 — usage recording needs the FULL row id; the emitted `id` above is
    // truncated to 12 chars for the envelope and would match no row. Keyed by
    // the result object rather than by index because `results` is sorted and
    // sliced before the returned set is known. Never spread into the response.
    //
    // Null for a namespace-scoped search of a structural namespace: nothing it
    // returns can be durable, so it skips the bookkeeping outright rather than
    // testing every row against a set that will never match.
    const durableIdByResult: Map<object, string> | null =
      namespace === 'all' || isDurableNamespace(namespace) ? new Map() : null;

    for (const row of rows) {
      let semanticScore = 0;
      let bm25ScoreVal = 0;
      const rowContent = String(row.content || '');

      if (queryEmbedding && row.embedding) {
        try {
          const embedding = JSON.parse(String(row.embedding)) as number[];
          semanticScore = cosineSim(queryEmbedding, embedding);
        } catch {
          // Invalid embedding
        }
      }

      if (queryTerms.length > 0 && rowContent) {
        bm25ScoreVal = bm25Score(queryTerms, rowContent, avgDocLength, docCount, termDocFreqs);
        bm25ScoreVal = Math.min(bm25ScoreVal / 10, 1.0);
      }

      const usedSemantic = queryEmbedding != null;
      const score = usedSemantic ? 0.7 * semanticScore + 0.3 * bm25ScoreVal : bm25ScoreVal;

      if (score >= threshold) {
        const provenance = usedSemantic
          ? `semantic:${semanticScore.toFixed(3)}+bm25:${bm25ScoreVal.toFixed(3)}`
          : `bm25:${bm25ScoreVal.toFixed(3)}`;

        const metadataStr = row.metadata != null ? String(row.metadata) : undefined;

        const hit = {
          id: String(row.id).substring(0, 12),
          // The substring is a fallback id-prefix when key is missing —
          // applying it to the full expression truncates valid keys (#845).
          key: row.key ? String(row.key) : String(row.id).substring(0, 15),
          content: rowContent.substring(0, 60) + (rowContent.length > 60 ? '...' : ''),
          score,
          namespace: String(row.namespace || 'default'),
          provenance,
          metadata: metadataStr,
        };
        results.push(hit);
        // Per row, not per search: an `all`-namespace search returns mostly
        // structural hits, and storing an id only to discard it at flush time
        // is work every prompt in every consumer project would pay.
        if (durableIdByResult && isDurableNamespace(hit.namespace)) {
          durableIdByResult.set(hit, String(row.id));
        }
      }
    }

    results.sort((a, b) => b.score - a.score);

    const returned = results.slice(0, limit);

    // #1464 — record usage for the durable rows this search actually returned.
    // Placed after the slice so an over-fetched candidate the caller never sees
    // does not count as a read. Called even when this search returned none, so
    // a set left pending by an earlier search still gets its flush.
    if (durableIdByResult) {
      const durableIds: string[] = [];
      for (const r of returned) {
        const id = durableIdByResult.get(r);
        if (id) durableIds.push(id);
      }
      recordSearchAccess(ctx.db, durableIds, Date.now());
    }

    return {
      success: true,
      results: returned,
      searchTime: Date.now() - startTime,
      searchMethod: queryEmbedding ? 'hybrid-bm25-semantic' : 'bm25-only',
    };
  });
}

export async function bridgeListEntries(options: {
  namespace?: string;
  limit?: number;
  offset?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  entries: {
    id: string;
    key: string;
    namespace: string;
    size: number;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
  }[];
  total: number;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx) => {
    const { namespace, limit = 20, offset = 0 } = options;
    const nsFilter = namespace ? `AND namespace = ?` : '';
    const nsParams = namespace ? [namespace] : [];

    let total = 0;
    try {
      const countRows = execRows(
        ctx.db,
        `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' ${nsFilter}`,
        nsParams,
      );
      total = Number(countRows[0]?.cnt ?? 0);
    } catch {
      return null;
    }

    const entries: any[] = [];
    try {
      const rows = execRows(
        ctx.db,
        `SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at
         FROM memory_entries
         WHERE status = 'active' ${nsFilter}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
        [...nsParams, limit, offset],
      );
      for (const row of rows) {
        entries.push({
          id: String(row.id).substring(0, 20),
          key: row.key || String(row.id).substring(0, 15),
          namespace: row.namespace || 'default',
          size: String(row.content || '').length,
          accessCount: Number(row.access_count ?? 0),
          createdAt: row.created_at || new Date().toISOString(),
          updatedAt: row.updated_at || new Date().toISOString(),
          hasEmbedding: !!(row.embedding && String(row.embedding).length > 10),
        });
      }
    } catch {
      return null;
    }

    return { success: true, entries, total };
  });
}

/**
 * Get a specific entry via TieredCache → DB.
 */
export async function bridgeGetEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  found: boolean;
  /** Exactly the cached shape — a cache hit returns the stored value verbatim (#1396). */
  entry?: CachedEntry;
  cacheHit?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, namespace = 'default' } = options;

    const cacheKey = makeEntryCacheKey(namespace, key);
    const cached = await cacheGet(registry, cacheKey);

    // A value written by a pre-#1396 build carries only
    // `{id,key,namespace,content,embedding,metadata}`. Serving it means
    // fabricating the absent columns — which IS the bug — so treat a partial
    // value as a miss and fall through to the disk read, which returns the true
    // row and re-caches the full shape. Self-heals on the first read after an
    // in-place upgrade, and since the L1 cache is in-memory only, nothing
    // outlives the process anyway.
    // `content !== undefined` rather than a truthy test: a row whose content is
    // legitimately `''` would otherwise fail this check on every read, be
    // re-fetched from disk, re-cached as `''`, and fail again — a permanent
    // cache bypass for that key. Pre-existing, but this is the condition it
    // lives in.
    const usableCache = cached
      && cached.content !== undefined
      && cached.createdAt !== undefined
      && cached.hasEmbedding !== undefined
      && Array.isArray(cached.tags);

    if (usableCache) {
      // #1396 — a cache hit is still an access. The access_count bump used to
      // live only on the disk path below, so a row read repeatedly inside the
      // cache TTL reported the same count forever — and `accessCount` is an
      // orderable field (query-builder's `sortBy('accessCount')`) plus a stats
      // input, so the hottest rows ranked as the coldest.
      //
      // #1402 — the write is THROTTLED per key. Every hit still increments the
      // count the caller sees; the DB write is coalesced to at most one per
      // ACCESS_FLUSH_INTERVAL_MS, because this function runs inside fan-out
      // loops (see the constant's docstring) where a write-per-hit is ~60
      // writes/sec against the same handful of keys.
      //
      // The UPDATE adds the accumulated delta and is evaluated by SQLite, so
      // the stored counter stays correct under concurrency and never depends on
      // a client-computed absolute. No persist call here on purpose — the disk
      // path below has never had one either, because #1058 removed the
      // read-side `db.export()` writeback that clobbered concurrent writers.
      // Under node:sqlite the UPDATE is durable regardless.
      const now = Date.now();

      // MUTATE THE CACHED RECORD IN PLACE — do not rebuild it.
      //
      // The guarantee this rests on is OBJECT IDENTITY, not synchrony:
      // `TieredCacheManager.get` is async, but it hands back the stored object
      // unchanged from `CacheManager.get`, which returns `node.value.data` with
      // no clone. So every concurrent reader of this key holds the SAME object,
      // and the two lines below are a read-modify-write with no `await` between
      // the read and the write — atomic under Node's single thread.
      //
      // Building a replacement record and writing it back with `cacheSet`
      // instead reintroduces a lost update: both callers read the same delta
      // across the await boundary and the second write clobbers the first,
      // permanently dropping an access. That interleaving is reachable on the
      // very workload this throttle is for — the neighbour fan-out fetches
      // adjacent chunk keys in parallel and two hits can share a neighbour.
      //
      // If the cache ever starts cloning on read, the delta stops accumulating
      // and this silently under-persists. `loses no counts when the same key is
      // read concurrently` is the test that would catch it.
      cached.accessCount = (cached.accessCount ?? 0) + 1;
      cached.pendingAccessDelta = (cached.pendingAccessDelta ?? 0) + 1;

      // A record with no flush stamp (pre-#1402 shape, or one this process has
      // never flushed) flushes immediately rather than waiting out the interval.
      const lastFlushAt = cached.lastAccessFlushAt ?? 0;
      if (now - lastFlushAt >= ACCESS_FLUSH_INTERVAL_MS) {
        try {
          ctx.db.prepare(ACCESS_BUMP_SQL)
            .run([cached.pendingAccessDelta, now, String(cached.id || '')]);
          // Clear ONLY after the write lands. Clearing on a throw would discard
          // the accumulated hits outright — the throttle defers writes, it does
          // not drop them.
          cached.pendingAccessDelta = 0;
          cached.lastAccessFlushAt = now;
        } catch {
          // Non-fatal — the delta rides along to the next attempt.
        }
      }

      // Built field-by-field from the cached record rather than spread from it,
      // so the throttle bookkeeping can never surface in an MCP response.
      const entry: CachedEntry = {
        id: String(cached.id || ''),
        key: cached.key || key,
        namespace: cached.namespace || namespace,
        content: cached.content,
        accessCount: cached.accessCount,
        createdAt: cached.createdAt,
        updatedAt: cached.updatedAt,
        hasEmbedding: cached.hasEmbedding,
        tags: cached.tags,
        metadata: cached.metadata || undefined,
      };

      // No `cacheSet` here: the record above IS the cached object and was
      // updated in place, so writing a copy back would be redundant work on the
      // hot path — and would reopen the lost-update window this branch closes.

      return { success: true, found: true, cacheHit: true, entry };
    }

    let row: any;
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at, tags, metadata
        FROM memory_entries
        WHERE status = 'active' AND key = ? AND namespace = ?
        LIMIT 1
      `);
      // sql.js: Statement.get returns a positional array, not an object.
      // Use getAsObject to read columns by name downstream. Bindings are
      // passed as a single array — varargs are silently ignored.
      row = stmt.getAsObject([key, namespace]);
      // #998: sql.js `getAsObject` zips SELECT column names with their values
      // even on a no-row result, so the returned object always has keys —
      // check the TEXT-NOT-NULL primary key to detect a real row.
      if (!row || row.id == null) row = null;
    } catch {
      return null;
    }

    if (!row) return { success: true, found: false };

    // The disk path writes its own +1 immediately (it is by definition not a
    // repeat read), so it doubles as this key's flush point: stamp `now` below
    // and start the delta at 0 so the next cache hit begins a fresh interval
    // rather than re-counting this access (#1402).
    const diskReadAt = Date.now();
    try {
      ctx.db.prepare(
        `UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      ).run([diskReadAt, row.id]);
    } catch {
      // Non-fatal
    }

    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { /* invalid */ }
    }

    const entry = {
      id: String(row.id),
      key: row.key || String(row.id),
      namespace: row.namespace || 'default',
      content: row.content || '',
      accessCount: (row.access_count ?? 0) + 1,
      createdAt: row.created_at || new Date().toISOString(),
      updatedAt: row.updated_at || new Date().toISOString(),
      hasEmbedding: !!(row.embedding && String(row.embedding).length > 10),
      tags,
      metadata: row.metadata != null ? String(row.metadata) : undefined,
    };

    await cacheSet(registry, cacheKey, {
      ...entry,
      pendingAccessDelta: 0,
      lastAccessFlushAt: diskReadAt,
    });

    return { success: true, found: true, cacheHit: false, entry };
  });
}

/**
 * Hard-delete an entry. Guarded, cache-invalidated, attested.
 *
 * Failure modes (issue #963): every non-success path now carries a
 * human-readable `error` so MCP callers can surface the reason instead
 * of seeing a silent `{ deleted: false }`.
 */
export async function bridgeDeleteEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  key: string;
  namespace: string;
  remainingEntries: number;
  guarded?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, namespace = 'default' } = options;
    const deleteFail = (error: string) =>
      ({ success: false, deleted: false, key, namespace, remainingEntries: 0, error } as const);

    const guardResult = await guardValidate(registry, 'delete', { key, namespace });
    if (!guardResult.allowed) {
      return deleteFail(`MutationGuard rejected: ${guardResult.reason}`);
    }

    let existed = false;
    try {
      const existsRows = execRows(
        ctx.db,
        `SELECT 1 as found FROM memory_entries WHERE key = ? AND namespace = ? AND status = 'active' LIMIT 1`,
        [key, namespace],
      );
      existed = existsRows.length > 0;
    } catch (err) {
      return deleteFail(`DB read failed during delete pre-check: ${errorDetail(err)}`);
    }

    if (!existed) {
      return deleteFail(`Key '${key}' not found in namespace '${namespace}'`);
    }

    let changes = 0;
    try {
      // Durable namespaces archive rather than hard-delete, so the deletion can
      // reach the team artifact and sibling worktrees (#1463). Same rule as the
      // offline path in `entries-write.deleteEntry` — see the rationale there.
      if (isDurableNamespace(namespace)) {
        archiveDurableRow(ctx.db, namespace, key, Date.now());
      } else {
        ctx.db.prepare(`
          DELETE FROM memory_entries
          WHERE key = ? AND namespace = ? AND status = 'active'
        `).run([key, namespace]);
      }
      // sql.js Statement.run returns true/false, not { changes }. Use
      // db.getRowsModified() to read the row count from the last statement —
      // an UPDATE reports rows affected the same way, so the zero-rows
      // inconsistency check below covers the archive path too.
      changes = ctx.db.getRowsModified?.() ?? 0;
    } catch (err) {
      return deleteFail(`DELETE failed: ${errorDetail(err)}`);
    }

    if (changes === 0) {
      // SELECT found the row but DELETE removed nothing. Most likely cause:
      // bridge holds an in-memory snapshot that diverged from disk
      // (sql.js writeback semantics — see feedback_sqljs_writeback_clobber.md).
      return deleteFail(
        `Internal inconsistency: row matched SELECT but DELETE removed 0 rows (key='${key}', namespace='${namespace}'). Possible bridge cache staleness — restart the daemon and retry.`,
      );
    }

    // Honest persist (#982). If the persist throws, the DELETE didn't reach
    // disk — the row will reappear on next process load. Surface as a failure
    // and skip cache invalidation so the cache stays consistent with disk.
    const persisted = tryPersist(ctx.db, options.dbPath);
    if (!persisted.ok) {
      return deleteFail(persisted.error);
    }
    await cacheInvalidate(registry, makeEntryCacheKey(namespace, key));
    await logAttestation(registry, 'delete', key, { namespace });

    let remaining = 0;
    try {
      const countRows = execRows(ctx.db, `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`);
      remaining = Number(countRows[0]?.cnt ?? 0);
    } catch {
      // Non-fatal — count is informational
    }

    refreshVectorStatsCache();

    // Commit the delete mutation in the dedupe buffer (#1098). The row is
    // gone from disk and the cache is invalidated, so this is the safe
    // point to record — a SQLITE_BUSY mid-DELETE earlier would have caught
    // in the try/catch above and never reached here.
    guardCommit(guardResult.commit);

    return {
      success: true,
      deleted: true,
      key,
      namespace,
      remainingEntries: remaining,
      guarded: true,
    };
  });
}
