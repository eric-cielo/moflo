/**
 * Bridge entries store — CLI-facing memory_entries operations.
 *
 * This is the sql.js `memory_entries` table the bridge owns directly
 * (not a moflo controller table). Separated out of memory-bridge.ts
 * to keep the top-level bridge a thin controller-op wrapper.
 *
 * @module v3/cli/bridge-entries
 */

import { cosineSim, execRows, generateId, persistBridgeDb, refreshVectorStatsCache, withDb } from './bridge-core.js';
import { EMBEDDING_MODEL_OPT_OUT, getBridgeEmbedder } from './bridge-embedder.js';

function makeEntryCacheKey(namespace: string, key: string): string {
  const safeNs = String(namespace).replace(/:/g, '_');
  const safeKey = String(key).replace(/:/g, '_');
  return `entry:${safeNs}:${safeKey}`;
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

async function guardValidate(
  registry: any,
  operation: string,
  params: Record<string, unknown>,
): Promise<{ allowed: boolean; reason?: string }> {
  const guard = registry.get('mutationGuard');
  if (!guard) return { allowed: true };
  const result = guard.validate({ operation, params, timestamp: Date.now() });
  return { allowed: result?.allowed === true, reason: result?.reason };
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
 */
export async function bridgeStoreEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
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
      return { success: false, id, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    let embeddingJson: string | null = null;
    let dimensions = 0;
    let model: string = EMBEDDING_MODEL_OPT_OUT;

    const wantsEmbedding = options.generateEmbeddingFlag !== false && value.length > 0;
    if (wantsEmbedding) {
      const embedder = getBridgeEmbedder();
      try {
        const vector = await embedder.embed(value);
        embeddingJson = JSON.stringify(Array.from(vector));
        dimensions = vector.length;
        model = embedder.model;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { success: false, id, error: `embedding generation failed: ${reason}` };
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
    const stmt = ctx.db.prepare(insertSql);
    stmt.run([
      id, key, namespace, value,
      embeddingJson, dimensions || null, model,
      tags.length > 0 ? JSON.stringify(tags) : null,
      '{}',
      now, now,
      ttl ? now + (ttl * 1000) : null,
    ]);
    persistBridgeDb(ctx.db, options.dbPath);

    const cacheKey = makeEntryCacheKey(namespace, key);
    await cacheSet(registry, cacheKey, { id, key, namespace, content: value, embedding: embeddingJson });

    await logAttestation(registry, 'store', id, { key, namespace, hasEmbedding: !!embeddingJson });

    if (embeddingJson) refreshVectorStatsCache();

    return {
      success: true,
      id,
      embedding: embeddingJson ? { dimensions, model } : undefined,
      guarded: true,
      cached: true,
      attested: true,
    };
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
  }[];
  searchTime: number;
  searchMethod?: string;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx) => {
    const { query: queryStr, namespace = 'default', limit = 10, threshold = 0.3 } = options;
    const startTime = Date.now();

    let queryEmbedding: number[] | null = null;
    try {
      const embedder = ctx.mofloDb.embedder;
      if (embedder) {
        const emb = await embedder.embed(queryStr);
        queryEmbedding = Array.from(emb);
      }
    } catch {
      // Fall back to keyword search
    }

    const nsFilter = namespace !== 'all' ? `AND namespace = ?` : '';

    let rows: Record<string, unknown>[];
    try {
      const sql = `
        SELECT id, key, namespace, content, embedding
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        LIMIT 1000
      `;
      rows = namespace !== 'all' ? execRows(ctx.db, sql, [namespace]) : execRows(ctx.db, sql);
    } catch {
      return null;
    }

    const queryTerms = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const { termDocFreqs, avgDocLength } = computeTermDocFreqs(queryTerms, rows);
    const docCount = rows.length;

    const results: { id: string; key: string; content: string; score: number; namespace: string; provenance?: string }[] = [];

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

        results.push({
          id: String(row.id).substring(0, 12),
          key: String(row.key || row.id).substring(0, 15),
          content: rowContent.substring(0, 60) + (rowContent.length > 60 ? '...' : ''),
          score,
          namespace: String(row.namespace || 'default'),
          provenance,
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
        },
      };
    }

    let row: any;
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at, tags
        FROM memory_entries
        WHERE status = 'active' AND key = ? AND namespace = ?
        LIMIT 1
      `);
      // sql.js: Statement.get returns a positional array, not an object.
      // Use getAsObject to read columns by name downstream. Bindings are
      // passed as a single array — varargs are silently ignored.
      row = stmt.getAsObject([key, namespace]);
      // getAsObject returns {} when no row matches; treat as null.
      if (!row || Object.keys(row).length === 0) row = null;
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
    };

    await cacheSet(registry, cacheKey, entry);

    return { success: true, found: true, cacheHit: false, entry };
  });
}

/**
 * Soft-delete an entry. Guarded, cache-invalidated, attested.
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

    const guardResult = await guardValidate(registry, 'delete', { key, namespace });
    if (!guardResult.allowed) {
      return { success: false, deleted: false, key, namespace, remainingEntries: 0, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    let changes = 0;
    try {
      ctx.db.prepare(`
        UPDATE memory_entries
        SET status = 'deleted', updated_at = ?
        WHERE key = ? AND namespace = ? AND status = 'active'
      `).run([Date.now(), key, namespace]);
      // sql.js Statement.run returns true/false, not { changes }. Use
      // db.getRowsModified() to read the row count from the last statement.
      changes = ctx.db.getRowsModified?.() ?? 0;
    } catch {
      return null;
    }

    if (changes > 0) persistBridgeDb(ctx.db, options.dbPath);

    await cacheInvalidate(registry, makeEntryCacheKey(namespace, key));

    if (changes > 0) {
      await logAttestation(registry, 'delete', key, { namespace });
    }

    let remaining = 0;
    try {
      const result = ctx.db.exec(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`);
      remaining = result[0]?.values?.[0]?.[0] ?? 0;
    } catch {
      // Non-fatal
    }

    if (changes > 0) refreshVectorStatsCache();

    return {
      success: true,
      deleted: changes > 0,
      key,
      namespace,
      remainingEntries: remaining,
      guarded: true,
    };
  });
}
