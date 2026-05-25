/**
 * Memory entry read path: search / list / get / namespace counts.
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition). All reads
 * follow the #1058 read-side routing preamble (route through the daemon's
 * HTTP RPC when reachable so callers see its authoritative post-write state),
 * then the AgentDB v3 bridge, then a direct node:sqlite query.
 *
 * @module memory/entries-read
 */

import * as fs from 'fs';
import { errorDetail } from '../shared/utils/error-detail.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';
import { ensureSchemaColumns } from './schema.js';
import { generateEmbedding } from './embedding-model.js';
import { searchHNSWIndex } from './hnsw-singleton.js';
import { getBridge } from './bridge-loader.js';
import { tryDaemonGet, tryDaemonSearch, tryDaemonList } from './daemon-write-client.js';
import { searchCandidateCap } from './bridge-core.js';
import { cosineSim, logRoutingFault } from './entries-shared.js';

/**
 * Search entries via node:sqlite with vector similarity.
 * Uses HNSW index for 150x faster search when available.
 */
export async function searchEntries(options: {
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
    metadata?: string;
  }[];
  searchTime: number;
  error?: string;
}> {
  // #1058 — read-side routing preamble. When a daemon is reachable AND we're
  // not the daemon ourselves AND no custom dbPath was supplied, route the
  // search through the daemon's HTTP RPC so callers see its authoritative,
  // up-to-the-write state. Without this, a non-daemon process queries its
  // own bridge's sql.js snapshot loaded at process-start and never sees
  // anything the daemon has written since (epic #1054 silent-drop).
  if (
    !options.dbPath
    && process.env.MOFLO_IS_DAEMON !== '1'
    && process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1'
  ) {
    try {
      const routed = await tryDaemonSearch({
        query: options.query,
        namespace: options.namespace,
        limit: options.limit,
        threshold: options.threshold,
      });
      if (routed.routed && routed.data) {
        return {
          success: true,
          results: routed.data.results,
          searchTime: routed.data.searchTime ?? 0,
        };
      }
      // #1101 — daemon rejected query (4xx); propagate instead of falling back.
      if (routed.routed && routed.error) {
        return { success: false, results: [], searchTime: 0, error: routed.error };
      }
    } catch (err) {
      logRoutingFault(err);
    }
  }

  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeSearchEntries(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: direct node:sqlite write via the unified factory.
  const {
    query,
    namespace = 'default',
    limit = 10,
    threshold = 0.3,
    dbPath: customPath
  } = options;

  const dbPath = customPath || memoryDbPath(process.cwd());
  const startTime = Date.now();

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, results: [], searchTime: 0, error: 'Database not found' };
    }

    // Ensure schema has all required columns (migration for older DBs)
    await ensureSchemaColumns(dbPath);

    // Generate query embedding
    const queryEmb = await generateEmbedding(query);
    const queryEmbedding = queryEmb.embedding;

    // Try HNSW search first (150x faster)
    const hnswResults = await searchHNSWIndex(queryEmbedding, { k: limit, namespace });
    if (hnswResults && hnswResults.length > 0) {
      // Filter by threshold
      const filtered = hnswResults.filter(r => r.score >= threshold);
      return {
        success: true,
        results: filtered,
        searchTime: Date.now() - startTime
      };
    }

    // Fall back to brute-force SQLite search via the unified factory.
    const db = openDaemonDatabase(dbPath);

    // Get entries with embeddings
    // #1201 — recency-ordered candidate cap (see searchCandidateCap). A bare
    // LIMIT truncated by rowid, hiding recent non-code-map namespaces from a
    // no-namespace search.
    const entries = db.exec(`
      SELECT id, key, namespace, content, metadata, embedding
      FROM memory_entries
      WHERE status = 'active'
        ${namespace !== 'all' ? `AND namespace = '${namespace.replace(/'/g, "''")}'` : ''}
      ORDER BY created_at DESC
      LIMIT ${searchCandidateCap()}
    `);

    const results: { id: string; key: string; content: string; score: number; namespace: string; metadata?: string }[] = [];

    if (entries[0]?.values) {
      for (const row of entries[0].values) {
        const [id, key, ns, content, metadataJson, embeddingJson] = row as [
          string, string, string, string, string | null, string | null
        ];

        let score = 0;

        if (embeddingJson) {
          try {
            const embedding = JSON.parse(embeddingJson) as number[];
            score = cosineSim(queryEmbedding, embedding);
          } catch {
            // Invalid embedding, use keyword score
          }
        }

        // Skip entries without valid semantic embeddings — keyword fallback
        // produces misleading 0.500 scores that degrade search quality.
        // Entries must have real vector embeddings to participate in semantic search.
        if (score < threshold) {
          continue;
        }

        if (score >= threshold) {
          results.push({
            id: id.substring(0, 12),
            key: key || id.substring(0, 15),
            content: (content || '').substring(0, 60) + ((content || '').length > 60 ? '...' : ''),
            score,
            namespace: ns || 'default',
            metadata: metadataJson || undefined
          });
        }
      }
    }

    db.close();

    // Sort by score
    results.sort((a, b) => b.score - a.score);

    return {
      success: true,
      results: results.slice(0, limit),
      searchTime: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      searchTime: Date.now() - startTime,
      error: errorDetail(error)
    };
  }
}

/**
 * List all entries from the memory database
 */
export async function listEntries(options: {
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
}> {
  // #1058 — read-side routing preamble (mirrors searchEntries/getEntry).
  if (
    !options.dbPath
    && process.env.MOFLO_IS_DAEMON !== '1'
    && process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1'
  ) {
    try {
      const routed = await tryDaemonList({
        namespace: options.namespace,
        limit: options.limit,
        offset: options.offset,
      });
      if (routed.routed && routed.data) {
        return { success: true, entries: routed.data.entries, total: routed.data.total };
      }
      // #1101 — daemon rejected list args (4xx); propagate.
      if (routed.routed && routed.error) {
        return { success: false, entries: [], total: 0, error: routed.error };
      }
    } catch (err) {
      logRoutingFault(err);
    }
  }

  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeListEntries(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: direct node:sqlite write via the unified factory.
  const {
    namespace,
    limit = 20,
    offset = 0,
    dbPath: customPath
  } = options;

  const dbPath = customPath || memoryDbPath(process.cwd());

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, entries: [], total: 0, error: 'Database not found' };
    }

    // Ensure schema has all required columns (migration for older DBs)
    await ensureSchemaColumns(dbPath);

    const db = openDaemonDatabase(dbPath);

    // Get total count
    const countQuery = namespace
      ? `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND namespace = '${namespace.replace(/'/g, "''")}'`
      : `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`;

    const countResult = db.exec(countQuery);
    const total = countResult[0]?.values?.[0]?.[0] as number || 0;

    // Get entries
    const listQuery = `
      SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at
      FROM memory_entries
      WHERE status = 'active'
        ${namespace ? `AND namespace = '${namespace.replace(/'/g, "''")}'` : ''}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const result = db.exec(listQuery);
    const entries: {
      id: string;
      key: string;
      namespace: string;
      size: number;
      accessCount: number;
      createdAt: string;
      updatedAt: string;
      hasEmbedding: boolean;
    }[] = [];

    if (result[0]?.values) {
      for (const row of result[0].values) {
        const [id, key, ns, content, embedding, accessCount, createdAt, updatedAt] = row as [
          string, string, string, string, string | null, number, string, string
        ];
        entries.push({
          id: String(id).substring(0, 20),
          key: key || String(id).substring(0, 15),
          namespace: ns || 'default',
          size: (content || '').length,
          accessCount: accessCount || 0,
          createdAt: createdAt || new Date().toISOString(),
          updatedAt: updatedAt || new Date().toISOString(),
          hasEmbedding: !!embedding && embedding.length > 10
        });
      }
    }

    db.close();

    return { success: true, entries, total };
  } catch (error) {
    return {
      success: false,
      entries: [],
      total: 0,
      error: errorDetail(error)
    };
  }
}

/**
 * Get a specific entry from the memory database
 */
export async function getEntry(options: {
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
  error?: string;
}> {
  // #1058 — read-side routing preamble (mirrors searchEntries/listEntries).
  if (
    !options.dbPath
    && process.env.MOFLO_IS_DAEMON !== '1'
    && process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1'
  ) {
    try {
      const routed = await tryDaemonGet({
        namespace: options.namespace ?? 'default',
        key: options.key,
      });
      if (routed.routed && routed.data) {
        return { success: true, found: routed.data.found, entry: routed.data.entry };
      }
      // #1101 — daemon rejected get args (4xx); propagate.
      if (routed.routed && routed.error) {
        return { success: false, found: false, error: routed.error };
      }
    } catch (err) {
      logRoutingFault(err);
    }
  }

  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeGetEntry(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: direct node:sqlite write via the unified factory.
  const {
    key,
    namespace = 'default',
    dbPath: customPath
  } = options;

  const dbPath = customPath || memoryDbPath(process.cwd());

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, found: false, error: 'Database not found' };
    }

    // Ensure schema has all required columns (migration for older DBs)
    await ensureSchemaColumns(dbPath);

    const db = openDaemonDatabase(dbPath);

    // Find entry by key
    const result = db.exec(`
      SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at, tags, metadata
      FROM memory_entries
      WHERE status = 'active'
        AND key = '${key.replace(/'/g, "''")}'
        AND namespace = '${namespace.replace(/'/g, "''")}'
      LIMIT 1
    `);

    if (!result[0]?.values?.[0]) {
      db.close();
      return { success: true, found: false };
    }

    const [id, entryKey, ns, content, embedding, accessCount, createdAt, updatedAt, tagsJson, metadataJson] = result[0].values[0] as [
      string, string, string, string, string | null, number, string, string, string | null, string | null
    ];

    // #1058: previously this path issued `UPDATE memory_entries SET access_count = ...`
    // followed by `atomicWriteFileSync(dbPath, db.export())` — a read that
    // dumped the entire DB snapshot back to disk just to bump access_count.
    // Any write by another process between this function's readFileSync and
    // the writeback was clobbered (read-side writeback-clobber). Access_count
    // is observability, not correctness — drop the writeback. The caller's
    // return value reports the in-memory incremented count so existing
    // surfaces aren't disturbed; persistence of the counter is deferred to a
    // future controller-table refactor (out of scope).

    db.close();

    let tags: string[] = [];
    if (tagsJson) {
      try {
        tags = JSON.parse(tagsJson);
      } catch {
        // Invalid JSON
      }
    }

    return {
      success: true,
      found: true,
      entry: {
        id: String(id),
        key: entryKey || String(id),
        namespace: ns || 'default',
        content: content || '',
        accessCount: (accessCount || 0) + 1,
        createdAt: createdAt || new Date().toISOString(),
        updatedAt: updatedAt || new Date().toISOString(),
        hasEmbedding: !!embedding && embedding.length > 10,
        tags,
        metadata: metadataJson || undefined
      }
    };
  } catch (error) {
    return {
      success: false,
      found: false,
      error: errorDetail(error)
    };
  }
}

/**
 * Get memory stats via a single GROUP BY query — namespace counts plus the
 * number of rows that carry a non-null embedding. One trip to disk; the
 * server-side aggregation replaces a pre-#1149 client iteration that
 * fetched 100 000 rows just to count them.
 *
 * Throws on DB read errors. Returns a zero shape ONLY when the DB file
 * doesn't exist yet (the real "empty project" signal) — never swallows a
 * locked/corrupt-DB error into a fake zero, since that's the exact silent
 * wrong-answer this fix is for.
 */
export async function getNamespaceCounts(dbPath?: string): Promise<{
  namespaces: Record<string, number>;
  total: number;
  withEmbeddings: number;
}> {
  const resolvedPath = dbPath || memoryDbPath(process.cwd());

  if (!fs.existsSync(resolvedPath)) {
    return { namespaces: {}, total: 0, withEmbeddings: 0 };
  }

  const db = openDaemonDatabase(resolvedPath);
  try {
    const result = db.exec(
      "SELECT namespace, COUNT(*) AS cnt, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS emb_cnt " +
      "FROM memory_entries WHERE status = 'active' GROUP BY namespace ORDER BY cnt DESC"
    );

    const namespaces: Record<string, number> = {};
    let total = 0;
    let withEmbeddings = 0;
    if (result[0]?.values) {
      for (const row of result[0].values) {
        const ns = String(row[0]);
        const count = Number(row[1]);
        const embCount = Number(row[2] ?? 0);
        namespaces[ns] = count;
        total += count;
        withEmbeddings += embCount;
      }
    }
    return { namespaces, total, withEmbeddings };
  } finally {
    db.close();
  }
}
