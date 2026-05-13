/**
 * Bridge entries store — CLI-facing memory_entries operations.
 *
 * This is the sql.js `memory_entries` table the bridge owns directly
 * (not a moflo controller table). Separated out of memory-bridge.ts
 * to keep the top-level bridge a thin controller-op wrapper.
 *
 * @module v3/cli/bridge-entries
 */

import { cosineSim, execRows, generateId, logBridgeError, persistBridgeDb, refreshVectorStatsCache, withDb } from './bridge-core.js';
import { embeddingResponseFrom, getBridgeEmbedder, resolveBridgeEmbedding } from './bridge-embedder.js';
import { errorDetail } from '../shared/utils/error-detail.js';

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

async function cacheSet(registry: any, cacheKey: string, value: any): Promise<void> {
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
      await cacheSet(registry, cacheKey, {
        id, key, namespace, content: value,
        embedding: embeddingJson,
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
    const deferredBookkeeping: Array<{ cacheKey: string; cacheValue: unknown; entryId: string; entryKey: string; namespace: string; hasEmbedding: boolean }> = [];
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
        // #1064 — keep cache shape in sync with disk (see single-store path).
        cacheValue: {
          id, key, namespace, content: value,
          embedding: embeddingJson,
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
      const sql = `
        SELECT id, key, namespace, content, metadata, embedding
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        LIMIT 1000
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

        results.push({
          id: String(row.id).substring(0, 12),
          // The substring is a fallback id-prefix when key is missing —
          // applying it to the full expression truncates valid keys (#845).
          key: row.key ? String(row.key) : String(row.id).substring(0, 15),
          content: rowContent.substring(0, 60) + (rowContent.length > 60 ? '...' : ''),
          score,
          namespace: String(row.namespace || 'default'),
          provenance,
          metadata: metadataStr,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return {
      success: true,
      results: results.slice(0, limit),
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
  entry?: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
    metadata?: string;
  };
  cacheHit?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, namespace = 'default' } = options;

    const cacheKey = makeEntryCacheKey(namespace, key);
    const cached = await cacheGet(registry, cacheKey);
    if (cached && cached.content) {
      return {
        success: true,
        found: true,
        cacheHit: true,
        entry: {
          id: String(cached.id || ''),
          key: cached.key || key,
          namespace: cached.namespace || namespace,
          content: cached.content || '',
          accessCount: cached.accessCount ?? 0,
          createdAt: cached.createdAt || new Date().toISOString(),
          updatedAt: cached.updatedAt || new Date().toISOString(),
          hasEmbedding: !!cached.embedding,
          tags: cached.tags || [],
          metadata: cached.metadata || undefined,
        },
      };
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

    try {
      ctx.db.prepare(
        `UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      ).run([Date.now(), row.id]);
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

    await cacheSet(registry, cacheKey, entry);

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
      ctx.db.prepare(`
        DELETE FROM memory_entries
        WHERE key = ? AND namespace = ? AND status = 'active'
      `).run([key, namespace]);
      // sql.js Statement.run returns true/false, not { changes }. Use
      // db.getRowsModified() to read the row count from the last statement.
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
