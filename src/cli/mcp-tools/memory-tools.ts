/**
 * Memory MCP Tools for CLI — node:sqlite + HNSW backend
 *
 * Backed by Node's built-in `node:sqlite` engine (Phase 4 #1083 flipped the
 * default; Phase 5 #1084 deleted the prior sql.js path) plus an HNSW vector
 * index for semantic search. Auto-migrates legacy JSON stores on first use.
 *
 * @module v3/cli/mcp-tools/memory-tools
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { MCPTool } from './types.js';
import { GateService } from '../services/spell-gate.js';
import { BACKEND_LABEL } from '../memory/database-provider.js';

// Legacy JSON store interface (for migration)
interface LegacyMemoryEntry {
  key: string;
  value: unknown;
  metadata?: Record<string, unknown>;
  storedAt: string;
  accessCount: number;
  lastAccessed: string;
}

interface LegacyMemoryStore {
  entries: Record<string, LegacyMemoryEntry>;
  version: string;
}

// Paths
const MEMORY_DIR = '.moflo/memory';
const LEGACY_MEMORY_FILE = 'store.json';
const MIGRATION_MARKER = '.migrated-to-sqlite';

function getMemoryDir(): string {
  return resolve(MEMORY_DIR);
}

function getLegacyPath(): string {
  return resolve(join(MEMORY_DIR, LEGACY_MEMORY_FILE));
}

function getMigrationMarkerPath(): string {
  return resolve(join(MEMORY_DIR, MIGRATION_MARKER));
}

function ensureMemoryDir(): void {
  const dir = getMemoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Notify the spell gate that a memory search occurred.
 * PostToolUse hooks don't fire reliably for MCP tools (#354),
 * so the handler writes the flag directly via GateService.
 */
let _gateNotified = false;
function notifyMemoryGate(): void {
  if (_gateNotified) return;
  try {
    new GateService().recordMemorySearched();
    _gateNotified = true;
  } catch (err) {
    // Non-fatal — gate will still work via bash fallback
    if (process.env.DEBUG) process.stderr.write(`notifyMemoryGate: ${err}\n`);
  }
}

// D-2: Input bounds for memory parameters
const MAX_KEY_LENGTH = 1024;
const MAX_VALUE_SIZE = 1024 * 1024; // 1MB
const MAX_QUERY_LENGTH = 4096;

/**
 * RAG navigation surface for chunked guidance entries (#1053).
 *
 * The chunker (`bin/index-guidance.mjs`) writes per-chunk metadata
 * including parentDoc, parentPath, prevChunk, nextChunk, siblings,
 * hierarchical{Parent,Children}, chunkIndex, totalChunks, chunkTitle,
 * headerLevel. These were stored but never returned by memory_search /
 * memory_retrieve, so callers had no way to traverse — they retrieved
 * blindly. Now surfaced so the chunking architecture is callable.
 *
 * Non-chunk entries (manual stores, learnings, patterns, doc-* documents)
 * yield `null` — explicit "not navigable" signal.
 */
type NavigationFull = {
  parentDoc?: string;
  parentPath?: string;
  prevChunk: string | null;
  nextChunk: string | null;
  siblings?: string[];
  chunkIndex?: number;
  totalChunks?: number;
  hierarchicalParent?: string | null;
  hierarchicalChildren?: string[] | null;
  chunkTitle?: string;
  headerLevel?: number;
};

type NavigationCompact = {
  parentDoc?: string;
  prevChunk: string | null;
  nextChunk: string | null;
  chunkTitle?: string;
};

interface MemoryEntryWithMeta {
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
}

interface RetrievedEntry {
  key: string;
  namespace: string;
  value: unknown;
  tags: string[];
  storedAt: string;
  updatedAt: string;
  accessCount: number;
  hasEmbedding: boolean;
  navigation: NavigationFull | null;
  found: boolean;
  backend: string;
}

function parseNavigation(metadataJson: string | undefined, mode: 'full'): NavigationFull | null;
function parseNavigation(metadataJson: string | undefined, mode: 'compact'): NavigationCompact | null;
function parseNavigation(
  metadataJson: string | undefined,
  mode: 'full' | 'compact',
): NavigationFull | NavigationCompact | null {
  if (!metadataJson) return null;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadataJson);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object') return null;
  // Discriminator: only `type === 'chunk'` entries carry the nav fields.
  if (meta.type !== 'chunk') return null;

  if (mode === 'compact') {
    return {
      parentDoc: meta.parentDoc as string | undefined,
      prevChunk: (meta.prevChunk as string | null | undefined) ?? null,
      nextChunk: (meta.nextChunk as string | null | undefined) ?? null,
      chunkTitle: meta.chunkTitle as string | undefined,
    };
  }

  return {
    parentDoc: meta.parentDoc as string | undefined,
    parentPath: meta.parentPath as string | undefined,
    prevChunk: (meta.prevChunk as string | null | undefined) ?? null,
    nextChunk: (meta.nextChunk as string | null | undefined) ?? null,
    siblings: meta.siblings as string[] | undefined,
    chunkIndex: meta.chunkIndex as number | undefined,
    totalChunks: meta.totalChunks as number | undefined,
    hierarchicalParent: (meta.hierarchicalParent as string | null | undefined) ?? null,
    hierarchicalChildren: (meta.hierarchicalChildren as string[] | null | undefined) ?? null,
    chunkTitle: meta.chunkTitle as string | undefined,
    headerLevel: meta.headerLevel as number | undefined,
  };
}

function shapeRetrievedEntry(entry: MemoryEntryWithMeta): RetrievedEntry {
  let value: unknown = entry.content;
  try { value = JSON.parse(entry.content); } catch { /* keep string */ }
  return {
    key: entry.key,
    namespace: entry.namespace,
    value,
    tags: entry.tags,
    storedAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    accessCount: entry.accessCount,
    hasEmbedding: entry.hasEmbedding,
    navigation: parseNavigation(entry.metadata, 'full'),
    found: true,
    backend: BACKEND_LABEL,
  };
}

function validateMemoryInput(key?: string, value?: string, query?: string): void {
  if (key && key.length > MAX_KEY_LENGTH) {
    throw new Error(`Key exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
  }
  if (value && value.length > MAX_VALUE_SIZE) {
    throw new Error(`Value exceeds maximum size of ${MAX_VALUE_SIZE} bytes`);
  }
  if (query && query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }
}

/**
 * Check if legacy JSON store exists and needs migration
 */
function hasLegacyStore(): boolean {
  const legacyPath = getLegacyPath();
  const migrationMarker = getMigrationMarkerPath();
  return existsSync(legacyPath) && !existsSync(migrationMarker);
}

/**
 * Load legacy JSON store for migration
 */
function loadLegacyStore(): LegacyMemoryStore | null {
  try {
    const path = getLegacyPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return null on error
  }
  return null;
}

/**
 * Mark migration as complete
 */
function markMigrationComplete(): void {
  ensureMemoryDir();
  writeFileSync(getMigrationMarkerPath(), JSON.stringify({
    migratedAt: new Date().toISOString(),
    version: '3.0.0',
  }), 'utf-8');
}

/**
 * Lazy-load memory initializer functions to avoid circular deps
 */
async function getMemoryFunctions() {
  const {
    storeEntry,
    searchEntries,
    listEntries,
    getEntry,
    deleteEntry,
    initializeMemoryDatabase,
    checkMemoryInitialization,
  } = await import('../memory/memory-initializer.js');

  return {
    storeEntry,
    searchEntries,
    listEntries,
    getEntry,
    deleteEntry,
    initializeMemoryDatabase,
    checkMemoryInitialization,
  };
}

/**
 * Ensure memory database is initialized and migrate legacy data if needed
 */
async function ensureInitialized(): Promise<void> {
  const { initializeMemoryDatabase, checkMemoryInitialization, storeEntry } = await getMemoryFunctions();

  // Check if already initialized
  const status = await checkMemoryInitialization();
  if (!status.initialized) {
    await initializeMemoryDatabase({ force: false, verbose: false });
  }

  // Migrate legacy JSON data if exists
  if (hasLegacyStore()) {
    const legacyStore = loadLegacyStore();
    if (legacyStore && Object.keys(legacyStore.entries).length > 0) {
      console.error('[MCP Memory] Migrating legacy JSON store to node:sqlite...');
      let migrated = 0;

      for (const [key, entry] of Object.entries(legacyStore.entries)) {
        try {
          // Convert value to string for storage
          const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
          await storeEntry({
            key,
            value,
            namespace: 'default',
            generateEmbeddingFlag: true,
          });
          migrated++;
        } catch (e) {
          console.error(`[MCP Memory] Failed to migrate key "${key}":`, e);
        }
      }

      console.error(`[MCP Memory] Migrated ${migrated}/${Object.keys(legacyStore.entries).length} entries`);
      markMigrationComplete();
    }
  }
}

export const memoryTools: MCPTool[] = [
  {
    name: 'memory_store',
    description: 'Store a value in memory with vector embedding for semantic search (node:sqlite + HNSW backend). Upserts by default — pass upsert:false to fail on duplicate keys. Optional `metadata` lets chunk-row producers set the navigation fields (parentDoc, prevChunk, nextChunk, siblings, …) that `memory_get_neighbors` reads.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (unique within namespace)' },
        value: { description: 'Value to store (string or object)' },
        namespace: { type: 'string', description: 'Namespace for organization (default: "default")' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering',
        },
        ttl: { type: 'number', description: 'Time-to-live in seconds (optional)' },
        upsert: { type: 'boolean', description: 'If false, fail on duplicate keys instead of replacing (default: true)' },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional per-row metadata persisted to the `metadata` TEXT column. For chunk entries, include `type: "chunk"` plus the navigation fields (parentDoc, parentPath, chunkIndex, totalChunks, prevChunk, nextChunk, siblings, hierarchicalParent, hierarchicalChildren, chunkTitle, headerLevel) so `memory_get_neighbors` can traverse. Capped at 64KB serialised.',
        },
      },
      required: ['key', 'value'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { storeEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';
      const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value);
      const tags = (input.tags as string[]) || [];
      const ttl = input.ttl as number | undefined;
      const metadata = input.metadata as Record<string, unknown> | string | undefined;
      // #962: default upsert=true — silent UNIQUE-constraint failures on update
      // were dropping schedule cancels and similar updates on the floor.
      const upsert = input.upsert === false ? false : true;

      validateMemoryInput(key, value);

      const startTime = performance.now();

      try {
        const result = await storeEntry({
          key,
          value,
          namespace,
          generateEmbeddingFlag: true,
          tags,
          ttl,
          metadata,
          upsert,
        });

        const duration = performance.now() - startTime;

        return {
          success: result.success,
          key,
          namespace,
          stored: result.success,
          storedAt: new Date().toISOString(),
          hasEmbedding: !!result.embedding,
          embeddingDimensions: result.embedding?.dimensions || null,
          backend: BACKEND_LABEL,
          storeTime: `${duration.toFixed(2)}ms`,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_retrieve',
    description: 'Retrieve the full value for a SPECIFIC key. For chunk entries, prefer `memory_get_neighbors` for traversal — bulk-retrieving search hits is a protocol violation. The returned `navigation` object lets you keep traversing. See `.claude/guidance/moflo-memory-protocol.md`.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { getEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';

      try {
        const result = await getEntry({ key, namespace });

        if (result.found && result.entry) {
          notifyMemoryGate();
          // #1053 S1: surface RAG navigation for chunked guidance entries.
          return shapeRetrievedEntry(result.entry as MemoryEntryWithMeta);
        }

        return {
          key,
          namespace,
          value: null,
          found: false,
        };
      } catch (error) {
        return {
          key,
          namespace,
          value: null,
          found: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_search',
    description: 'Semantic vector search using HNSW index (150x-12,500x faster than keyword search). When a result has a non-null `navigation` crumb, you MUST traverse via `memory_get_neighbors` — bulk `memory_retrieve` per hit is a protocol violation. See `.claude/guidance/moflo-memory-protocol.md`.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (semantic similarity)' },
        namespace: { type: 'string', description: 'Namespace to search (default: all namespaces)' },
        limit: { type: 'number', description: 'Maximum results (default: 8)' },
        threshold: { type: 'number', description: 'Minimum similarity threshold 0-1 (default: 0.5)' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { searchEntries } = await getMemoryFunctions();

      const query = input.query as string;
      const namespace = (input.namespace as string) || 'all';
      // #1053 S6: tighter defaults — fewer hits, higher relevance bar.
      const limit = (input.limit as number) || 8;
      // Falsiness check would coerce a caller-supplied 0 to default and silently
      // filter low-similarity matches; use a typeof guard so explicit zero
      // means "no threshold" (#837).
      const threshold = typeof input.threshold === 'number' ? input.threshold : 0.5;

      validateMemoryInput(undefined, undefined, query);

      try {
        const result = await searchEntries({
          query,
          namespace,
          limit,
          threshold,
        });

        // Parse JSON values in results
        const results = result.results.map(r => {
          let value: unknown = r.content;
          try {
            value = JSON.parse(r.content);
          } catch {
            // Keep as string
          }

          // #1053 S1: compact RAG navigation crumb per result.
          // Compact subset is small enough to always include — keeps the
          // result envelope navigable without ballooning per-hit size.
          const navigation = parseNavigation((r as { metadata?: string }).metadata, 'compact');

          return {
            key: r.key,
            namespace: r.namespace,
            value,
            // #1053 S6: 2dp keeps signal, drops noise (8-decimal floats add ~6
            // bytes per hit and don't help any caller).
            similarity: Math.round(r.score * 100) / 100,
            navigation,
          };
        });

        notifyMemoryGate();

        // #1053 S6: searchTime dropped from MCP envelope (CLI keeps it for
        // human reading); `backend` retained — doctor reads it (#1053 epic).
        return {
          query,
          results,
          total: results.length,
          backend: BACKEND_LABEL,
        };
      } catch (error) {
        return {
          query,
          results: [],
          total: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_get_neighbors',
    description: 'Traverse the chunk graph in one call: fetch the requested neighbors (prev/next/siblings/parent/children) of a chunk key. Returns success:false if the source is not a chunk.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Source chunk key (must be a chunk-* entry)' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['prev', 'next', 'siblings', 'parent', 'children'] },
          description: "Which neighbors to fetch. Default: ['prev','next']. parent/children = hierarchical (h2→h3) chunk neighbors; siblings = same-doc chunk peers.",
        },
      },
      required: ['key'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { getEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';
      const includeRaw = input.include as string[] | undefined;
      const include = Array.isArray(includeRaw) && includeRaw.length > 0 ? includeRaw : ['prev', 'next'];

      validateMemoryInput(key);

      try {
        const sourceResult = await getEntry({ key, namespace });
        if (!sourceResult.found || !sourceResult.entry) {
          return {
            success: false,
            key,
            namespace,
            error: `Source key '${key}' not found in namespace '${namespace}'`,
          };
        }

        const sourceMeta = (sourceResult.entry as { metadata?: string }).metadata;
        const nav = parseNavigation(sourceMeta, 'full');
        if (!nav) {
          return {
            success: false,
            key,
            namespace,
            error: `Source key '${key}' has no chunk metadata; only chunk-* entries are navigable`,
          };
        }

        // Resolve requested neighbor keys, dedup, exclude the source key itself.
        const neighborKeys = new Set<string>();
        const addIfChunkKey = (k: string | null | undefined): void => {
          if (k && k !== key) neighborKeys.add(k);
        };
        for (const inc of include) {
          if (inc === 'prev') addIfChunkKey(nav.prevChunk);
          else if (inc === 'next') addIfChunkKey(nav.nextChunk);
          else if (inc === 'siblings') (nav.siblings ?? []).forEach(addIfChunkKey);
          else if (inc === 'parent') addIfChunkKey(nav.hierarchicalParent);
          else if (inc === 'children') (nav.hierarchicalChildren ?? []).forEach(addIfChunkKey);
        }

        // Parallel fetch — one round-trip from the caller's perspective.
        // Missing neighbors (deleted/renamed) are silently skipped rather
        // than failing the whole call; the response.total reflects what
        // we actually returned.
        const fetched = await Promise.all(
          Array.from(neighborKeys).map(async k => {
            const res = await getEntry({ key: k, namespace });
            return res.found && res.entry ? shapeRetrievedEntry(res.entry as MemoryEntryWithMeta) : null;
          }),
        );

        notifyMemoryGate();

        const neighbors = fetched.filter((e): e is RetrievedEntry => e !== null);

        return {
          success: true,
          source: { key, namespace },
          include,
          neighbors,
          total: neighbors.length,
          backend: BACKEND_LABEL,
        };
      } catch (error) {
        return {
          success: false,
          key,
          namespace,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory entry by key',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { deleteEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';

      try {
        const result = await deleteEntry({ key, namespace });

        // Issue #963: surface the underlying reason when delete fails.
        // `result.success` reflects whether the call itself succeeded; we
        // require `deleted === true` for the MCP-level success boolean,
        // and pass `result.error` through whenever the delete didn't take.
        const deleted = result.deleted === true;
        const errorReason = !deleted
          ? (result.error ?? `No entry deleted (key='${key}', namespace='${namespace}'); reason not reported by storage layer`)
          : undefined;

        return {
          success: result.success === true && deleted,
          key,
          namespace,
          deleted,
          backend: BACKEND_LABEL,
          ...(errorReason ? { error: errorReason } : {}),
        };
      } catch (error) {
        return {
          success: false,
          key,
          namespace,
          deleted: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_list',
    description: 'List memory entries with optional filtering',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Filter by namespace' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
        offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const { listEntries } = await getMemoryFunctions();

      const namespace = input.namespace as string | undefined;
      const limit = (input.limit as number) || 50;
      const offset = (input.offset as number) || 0;

      try {
        const result = await listEntries({
          namespace,
          limit,
          offset,
        });

        const entries = result.entries.map(e => ({
          key: e.key,
          namespace: e.namespace,
          storedAt: e.createdAt,
          updatedAt: e.updatedAt,
          accessCount: e.accessCount,
          hasEmbedding: e.hasEmbedding,
          size: e.size,
        }));

        return {
          entries,
          total: result.total,
          limit,
          offset,
          backend: BACKEND_LABEL,
        };
      } catch (error) {
        return {
          entries: [],
          total: 0,
          limit,
          offset,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory storage statistics including HNSW index status',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      await ensureInitialized();
      const { checkMemoryInitialization, listEntries } = await getMemoryFunctions();

      try {
        const status = await checkMemoryInitialization();
        const allEntries = await listEntries({ limit: 100000 });

        // Count by namespace
        const namespaces: Record<string, number> = {};
        let withEmbeddings = 0;

        for (const entry of allEntries.entries) {
          namespaces[entry.namespace] = (namespaces[entry.namespace] || 0) + 1;
          if (entry.hasEmbedding) withEmbeddings++;
        }

        return {
          initialized: status.initialized,
          totalEntries: allEntries.total,
          entriesWithEmbeddings: withEmbeddings,
          embeddingCoverage: allEntries.total > 0
            ? `${((withEmbeddings / allEntries.total) * 100).toFixed(1)}%`
            : '0%',
          namespaces,
          backend: BACKEND_LABEL,
          version: status.version || '3.0.0',
          features: status.features || {
            vectorEmbeddings: true,
            hnswIndex: true,
            semanticSearch: true,
          },
        };
      } catch (error) {
        return {
          initialized: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
];
