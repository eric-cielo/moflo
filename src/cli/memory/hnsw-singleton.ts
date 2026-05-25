/**
 * Process-wide HNSW vector-index singleton (150x faster vector search).
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
import { tryLoadHnswSidecar } from './hnsw-persistence.js';
import { parseEmbeddingJson } from './controllers/_shared.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';
import { getBridge, isBridgeLoaded } from './bridge-loader.js';

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
    const dbPath = options?.dbPath || memoryDbPath(process.cwd());
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
        const result = sqlDb.exec(`
          SELECT ${cols}
          FROM memory_entries
          WHERE status = 'active' AND embedding IS NOT NULL
          LIMIT 10000
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
 * Search HNSW index (150x faster than brute-force)
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

  try {
    const vector = new Float32Array(queryEmbedding);
    const k = options?.k ?? 10;

    // HNSW search returns results with cosine distance (lower = more similar)
    const results = await index.db.search({ vector, k: k * 2 }); // Get extra for filtering

    const filtered: Array<{ id: string; key: string; content: string; score: number; namespace: string; metadata?: string }> = [];

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

      filtered.push({
        id: entry.id.substring(0, 12),
        key: entry.key || entry.id.substring(0, 15),
        content: entry.content.substring(0, 60) + (entry.content.length > 60 ? '...' : ''),
        score,
        namespace: entry.namespace,
        metadata: entry.metadata
      });

      if (filtered.length >= k) break;
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
 * Clear the HNSW index (for rebuilding)
 */
export function clearHNSWIndex(): void {
  hnswIndex = null;
}
