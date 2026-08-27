/**
 * Process-wide HNSW vector-index singleton (approximate-nearest-neighbor search).
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition). Owns the
 * lazy HNSW index built from the SQLite `embedding` column (or a binary
 * sidecar), plus add/search/status/clear. Uses the pure-TS {@link HnswLite}
 * implementation — no native dependencies.
 *
 * Distinct from `hnsw-index.ts` (the standalone HNSWConfig/HNSWStats
 * implementation): this module is the singleton the memory-CRUD path wires
 * into via `getHNSWIndex` / `addToHNSWIndex` / `searchHNSWIndex`.
 *
 * @module memory/hnsw-singleton
 */

import * as fs from 'fs';
import * as path from 'path';
import { HnswLite } from './hnsw-lite.js';
import { readHnswSidecarStatus, tryLoadHnswSidecar } from './hnsw-persistence.js';
import { parseEmbeddingJson } from './controllers/_shared.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';
import { getBridge, isBridgeLoaded } from './bridge-loader.js';
import { searchCandidateCap } from './bridge-core.js';
import { resolveStateRoot } from '../services/project-root.js';

interface HNSWEntry {
  id: string;
  key: string;
  namespace: string;
  content: string;
  metadata?: string; // JSON string from memory_entries.metadata column (RAG nav fields for chunks)
}

interface HNSWIndex {
  db: any;
  entries: Map<string, HNSWEntry>;
  dimensions: number;
  initialized: boolean;
}

let hnswIndex: HNSWIndex | null = null;
let hnswInitializing = false;

/**
 * Get or create the HNSW index singleton
 * Lazily initializes from SQLite data on first use
 */
export async function getHNSWIndex(options?: {
  dbPath?: string;
  dimensions?: number;
  forceRebuild?: boolean;
}): Promise<HNSWIndex | null> {
  const dimensions = options?.dimensions ?? 384;

  // Return existing index if already initialized
  if (hnswIndex?.initialized && !options?.forceRebuild) {
    return hnswIndex;
  }

  // Prevent concurrent initialization
  if (hnswInitializing) {
    // Wait for initialization to complete
    while (hnswInitializing) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return hnswIndex;
  }

  hnswInitializing = true;

  try {
    // Use HnswLite pure TS implementation (no native dependencies).

    // Persistent storage paths — colocated with the canonical memory DB.
    const dbPath = options?.dbPath || memoryDbPath(resolveStateRoot());
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const projectRoot = path.dirname(dbDir);

    // Try the binary sidecar first — graph + neighbors round-trip exactly,
    // so the cold-start cost drops to one readFileSync + slice. Fall back
    // to SQL-rebuild only when the sidecar is missing or malformed.
    const loadedFromSidecar = options?.forceRebuild ? null : tryLoadHnswSidecar(projectRoot);
    const hnsw = loadedFromSidecar ?? new HnswLite(dimensions, 16, 200, 'cosine');
    const sidecarLoaded = loadedFromSidecar !== null;

    const db = {
      insert: async (entry: { id: string; vector: Float32Array }) => {
        hnsw.add(entry.id, entry.vector);
      },
      search: async (query: { vector: Float32Array; k: number }) => {
        return hnsw.search(query.vector, query.k);
      },
      len: async () => hnsw.size,
      remove: (id: string) => hnsw.remove(id),
    };

    const entries = new Map<string, HNSWEntry>();

    hnswIndex = {
      db,
      entries,
      dimensions,
      initialized: false
    };

    // Always populate the entries metadata from SQL — `key/namespace/content`
    // is the source of truth there, and the sidecar only stores vectors +
    // adjacency. When the sidecar IS loaded we skip the per-row JSON.parse
    // of the embedding column, which is the expensive part on a populated
    // consumer DB.
    const SELECT_WITH_EMBEDDING = `id, key, namespace, content, metadata, embedding`;
    const SELECT_METADATA_ONLY = `id, key, namespace, content, metadata`;

    if (fs.existsSync(dbPath)) {
      try {
        const sqlDb = openDaemonDatabase(dbPath);

        const cols = sidecarLoaded ? SELECT_METADATA_ONLY : SELECT_WITH_EMBEDDING;
        // #1468 — recency-ordered candidate cap, the same one `entries-read.ts`
        // and `memory-bridge.ts` already use. This load was a bare `LIMIT 10000`,
        // so which rows survived was b-tree order under `idx_memory_status` —
        // arbitrary with respect to both recency and namespace. That is #1201
        // recurring here; the sibling paths got the fix and this loader did not.
        const result = sqlDb.exec(`
          SELECT ${cols}
          FROM memory_entries
          WHERE status = 'active' AND embedding IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ${searchCandidateCap()}
        `);

        let parseSkipped = 0;
        if (result[0]?.values) {
          for (const row of result[0].values) {
            // Column order matches SELECT_WITH_EMBEDDING / SELECT_METADATA_ONLY.
            // When sidecar is loaded, embeddingJson is undefined (column absent).
            const [id, key, ns, content, metadataJson, embeddingJson] = row as [
              string, string, string, string, string | null, string?
            ];

            if (!sidecarLoaded) {
              const vec = parseEmbeddingJson(embeddingJson);
              if (!vec) {
                parseSkipped++;
                continue;
              }
              await db.insert({ id: String(id), vector: vec });
            }

            hnswIndex.entries.set(String(id), {
              id: String(id),
              key: key || String(id),
              namespace: ns || 'default',
              content: content || '',
              metadata: metadataJson || undefined
            });
          }
        }
        if (parseSkipped > 0) {
          console.warn(`[memory-initializer] skipped ${parseSkipped} rows with malformed embeddings`);
        }

        // #1468 — drop graph vectors the metadata load did not cover, so the two
        // structures agree.
        //
        // Only the sidecar path can disagree. When the sidecar is absent the loop
        // above inserts each vector alongside its metadata row, so the cap bounds
        // both together. `hnsw-persistence` builds the sidecar over every embedded
        // row with no LIMIT, so a store past the cap pairs a complete graph with a
        // truncated map — and `searchHNSWIndex` silently skips a hit it cannot
        // resolve (`if (!entry) continue`). Those vectors are unreachable by
        // construction: they consume graph space and ANN slots that would
        // otherwise hold a result the caller can actually receive. Rows past the
        // cap stay reachable through the complete brute-force scan in
        // `entries-read.ts`, which now runs whenever the ANN under-fills.
        //
        // Guarded on a non-empty map, which covers the SELECT that succeeds and
        // returns nothing: far more likely a read that went wrong than a store
        // whose rows all vanished, and emptying the graph on that reading is
        // unrecoverable until the next rebuild. A read that *throws* needs no
        // guard — it exits to the catch below and never reaches here, leaving the
        // graph exactly as the sidecar supplied it. Both ways out leave a stale
        // graph rather than an empty one, which is the cheaper mistake.
        if (sidecarLoaded && hnswIndex.entries.size > 0) {
          const orphaned: string[] = [];
          for (const id of hnsw.ids()) {
            if (!hnswIndex.entries.has(id)) orphaned.push(id);
          }
          for (const id of orphaned) hnsw.remove(id);
        }

        sqlDb.close();
      } catch (err) {
        console.warn(`[memory-initializer] SQL load failed, starting empty: ${(err as Error).message}`);
      }
    }

    hnswIndex.initialized = true;
    hnswInitializing = false;
    return hnswIndex;
  } catch (err) {
    console.warn(`[memory-initializer] getHNSWIndex failed: ${(err as Error).message}`);
    hnswInitializing = false;
    return null;
  }
}

/**
 * Add entry to HNSW index. Live-adds stay in-memory until the next
 * `memory rebuild-index` run rebuilds the binary sidecar at
 * `.moflo/hnsw.index`. The sql.js `embedding` column is the source of
 * truth across process boundaries.
 */
export async function addToHNSWIndex(
  id: string,
  embedding: number[],
  entry: HNSWEntry
): Promise<boolean> {
  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeAddToHNSW(id, embedding, entry);
    if (bridgeResult === true) return true;
  }

  const index = await getHNSWIndex({ dimensions: embedding.length });
  if (!index) return false;

  try {
    const vector = new Float32Array(embedding);
    await index.db.insert({
      id,
      vector
    });
    index.entries.set(id, entry);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove an entry from the in-process HNSW index — graph vector and metadata
 * row both (#1468).
 *
 * `deleteEntry` used to delete the row and stop there. The store path maintains
 * the index (`addToHNSWIndex`); the delete path had no counterpart and there was
 * no removal function to call, even though `HnswLite.remove` has always existed.
 * `entries` is an in-process map rebuilt from SQL, so the consequence was not
 * merely an orphaned vector: the deleted entry's metadata outlived the row and
 * the local HNSW path could keep **returning deleted content** until the process
 * restarted. A curation pass had no way to see that.
 *
 * Addressed by (namespace, key) rather than id because that is what every caller
 * of `deleteEntry` has. The scan is linear, which is fine — deletes are rare and
 * searches are not, so the cost belongs here rather than in a second index.
 *
 * Never forces a load. When this process holds no initialized index there is
 * nothing stale to correct, and the next load reads a DB the row is already gone
 * from. Returns the number of entries removed.
 */
export function removeFromHNSWIndex(namespace: string, key: string): number {
  const index = hnswIndex;
  if (!index?.initialized) return 0;

  const ids: string[] = [];
  for (const [id, entry] of index.entries) {
    if (entry.key === key && entry.namespace === namespace) ids.push(id);
  }

  for (const id of ids) {
    index.entries.delete(id);
    try {
      index.db.remove?.(id);
    } catch {
      // A graph that refuses the removal leaves an unreachable vector, which is
      // the pre-#1468 state and strictly better than the metadata row surviving.
    }
  }

  return ids.length;
}

/**
 * Search HNSW index (approximate-nearest-neighbor; scales sub-linearly vs. brute-force)
 * Returns results sorted by similarity (highest first)
 */
export async function searchHNSWIndex(
  queryEmbedding: number[],
  options?: {
    k?: number;
    namespace?: string;
  }
): Promise<Array<{ id: string; key: string; content: string; score: number; namespace: string; metadata?: string }> | null> {
  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeSearchHNSW(queryEmbedding, options);
    if (bridgeResult) return bridgeResult;
  }

  const index = await getHNSWIndex({ dimensions: queryEmbedding.length });
  if (!index) return null;

  const k = options?.k ?? 10;

  type Hit = { id: string; key: string; content: string; score: number; namespace: string; metadata?: string };

  /** Resolve raw graph hits through the metadata map, applying the namespace filter. */
  const collect = (results: Array<{ id: string; score: number }>): Hit[] => {
    const hits: Hit[] = [];
    for (const result of results) {
      const entry = index.entries.get(result.id);
      if (!entry) continue;

      // Filter by namespace if specified
      if (options?.namespace && options.namespace !== 'all' && entry.namespace !== options.namespace) {
        continue;
      }

      // Convert cosine distance to similarity score (1 - distance)
      // Cosine distance: 0 = identical, 2 = opposite
      const score = 1 - (result.score / 2);

      hits.push({
        id: entry.id.substring(0, 12),
        key: entry.key || entry.id.substring(0, 15),
        content: entry.content.substring(0, 60) + (entry.content.length > 60 ? '...' : ''),
        score,
        namespace: entry.namespace,
        metadata: entry.metadata
      });

      if (hits.length >= k) break;
    }
    return hits;
  };

  try {
    const vector = new Float32Array(queryEmbedding);

    // HNSW search returns results with cosine distance (lower = more similar)
    let filtered = collect(await index.db.search({ vector, k: k * 2 })); // Get extra for filtering

    // #1468 — widen once when a namespace filter starved the result.
    //
    // The graph is one shared structure and the namespace filter runs AFTER
    // retrieval, so a namespace holding a small share of the store routinely
    // loses most of its `k * 2` candidates to rows in other namespaces and comes
    // back short. That shortfall is not a signal about the store — those entries
    // exist and a full scan would find them — and `searchEntries` reads a short
    // result as "the index could not serve this", which would send every
    // namespaced query on to a SQL scan that JSON.parses thousands of embeddings.
    //
    // `HnswLite.search` brute-forces whenever `k * 2` reaches the graph size, so
    // passing the size guarantees complete coverage. It is a cosine pass over
    // Float32Arrays already resident in memory — far cheaper than the SQL
    // fallback it replaces. Skipped when the first search already covered the
    // whole graph, since a second identical pass would add nothing.
    const graphSize: number = await index.db.len();
    const namespaced = Boolean(options?.namespace && options.namespace !== 'all');
    if (namespaced && filtered.length < k && graphSize > k * 2) {
      filtered = collect(await index.db.search({ vector, k: graphSize }));
    }

    // Sort by score descending (highest similarity first)
    filtered.sort((a, b) => b.score - a.score);

    return filtered;
  } catch {
    return null;
  }
}

/**
 * Get HNSW index status
 */
export function getHNSWStatus(): {
  available: boolean;
  initialized: boolean;
  entryCount: number;
  dimensions: number;
} {
  // ADR-053: If bridge was previously loaded, report availability
  if (isBridgeLoaded()) {
    // Bridge is loaded — HNSW-equivalent is available via AgentDB v3
    return {
      available: true,
      initialized: true,
      entryCount: hnswIndex?.entries.size ?? 0,
      dimensions: hnswIndex?.dimensions ?? 384
    };
  }

  return {
    available: hnswIndex !== null,
    initialized: hnswIndex?.initialized ?? false,
    entryCount: hnswIndex?.entries.size ?? 0,
    dimensions: hnswIndex?.dimensions ?? 384
  };
}

/**
 * Where an {@link EffectiveHNSWStatus} answer came from.
 *
 * - `process` — this process built an index and it holds vectors.
 * - `sidecar` — this process has no index of its own; the answer describes
 *   `.moflo/hnsw.index`, which is what the daemon serves searches from.
 * - `none` — neither exists. The index really is not built.
 */
export type HNSWStatusSource = 'process' | 'sidecar' | 'none';

export interface EffectiveHNSWStatus {
  available: boolean;
  initialized: boolean;
  /** `null` only when a sidecar exists but its vector count is unknowable. */
  entryCount: number | null;
  dimensions: number;
  source: HNSWStatusSource;
}

/**
 * Status of the index that will actually serve a search — not the caller's
 * own singleton (#1387).
 *
 * {@link getHNSWStatus} reports process-local state, which was a fair proxy
 * until #1058 routed reads through the daemon's RPC. Since then `searchEntries`
 * returns before ever touching `searchHNSWIndex`, so in the MCP server and CLI
 * the local singleton is never built — and reporting it told healthy installs
 * their index did not exist. The status inverted with health: it read `Active`
 * only in a process that had *failed* to reach the daemon.
 *
 * So: use the local index when one is genuinely populated, and otherwise fall
 * back to the sidecar on disk. Callers that specifically want process-local
 * state (a benchmark about to search in-process, a rebuild's before/after)
 * should keep calling {@link getHNSWStatus}.
 */
export function getEffectiveHNSWStatus(projectRoot?: string): EffectiveHNSWStatus {
  const local = getHNSWStatus();

  // `initialized && entryCount > 0` rather than `available` — a bridge-loaded
  // process reports available/initialized with a null singleton behind it, and
  // its entryCount of 0 is an artifact, not a measurement. A local index that
  // is genuinely built-but-empty falls through here too, which is the intended
  // answer both ways: with a sidecar on disk that is the more useful report,
  // and with none, an index holding zero vectors answers no search anyway.
  if (local.initialized && local.entryCount > 0) {
    return { ...local, source: 'process' };
  }

  try {
    const sidecar = readHnswSidecarStatus(projectRoot ?? resolveStateRoot());
    if (sidecar.present) {
      return {
        available: true,
        initialized: true,
        entryCount: sidecar.vectorCount,
        dimensions: sidecar.dimensions ?? local.dimensions,
        source: 'sidecar',
      };
    }
  } catch {
    // An unreadable state root is not evidence of a missing index, but there
    // is nothing left to consult — fall through to the honest negative.
  }

  return {
    available: false,
    initialized: false,
    entryCount: 0,
    dimensions: local.dimensions,
    source: 'none',
  };
}

/**
 * Clear the HNSW index (for rebuilding)
 */
export function clearHNSWIndex(): void {
  hnswIndex = null;
}
