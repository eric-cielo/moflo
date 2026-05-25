/**
 * V3 Memory Initializer — barrel.
 *
 * Historically this was a single 2,800-line module. As of #1203 it is split
 * into focused sub-modules (each <500 lines) and this file is a thin barrel
 * that re-exports their public surface so the ~60 existing importers stay
 * byte-identical. New code SHOULD import from the specific sub-module; this
 * barrel exists for back-compat and for the aggregate default export.
 *
 *   schema.ts          — MEMORY_SCHEMA_V3, getInitialMetadata, MemoryInitResult, ensureSchemaColumns
 *   quantization.ts    — int8 quantization + flash-attention batch ops
 *   hnsw-singleton.ts  — process-wide HNSW index singleton (get/add/search/status/clear)
 *   embedding-model.ts — fastembed model load + generateEmbedding(s)
 *   entries-write.ts   — storeEntry / storeEntries / deleteEntry
 *   entries-read.ts    — searchEntries / listEntries / getEntry / getNamespaceCounts
 *   init.ts            — initializeMemoryDatabase / checkAndMigrateLegacy / checkMemoryInitialization / applyTemporalDecay
 *   verify.ts          — verifyMemoryInit
 *   learnings-overview.ts — getLearningsOverview (#1203 Luminarium panel)
 *
 * (bridge-loader.ts and entries-shared.ts hold internal helpers and are
 * deliberately NOT re-exported here — they were file-private before the split.)
 *
 * ADR-053: Routes through ControllerRegistry → AgentDB v3 when available,
 * falls back to a direct node:sqlite write for backwards compatibility.
 *
 * @module v3/cli/memory-initializer
 */

export {
  MEMORY_SCHEMA_V3,
  getInitialMetadata,
  ensureSchemaColumns,
  type MemoryInitResult,
} from './schema.js';

export {
  quantizeInt8,
  dequantizeInt8,
  quantizedCosineSim,
  getQuantizationStats,
  batchCosineSim,
  softmaxAttention,
  topKIndices,
  flashAttentionSearch,
} from './quantization.js';

export {
  getHNSWIndex,
  addToHNSWIndex,
  searchHNSWIndex,
  getHNSWStatus,
  clearHNSWIndex,
} from './hnsw-singleton.js';

export {
  loadEmbeddingModel,
  generateEmbedding,
  generateBatchEmbeddings,
} from './embedding-model.js';

export {
  storeEntry,
  storeEntries,
  deleteEntry,
} from './entries-write.js';

export {
  searchEntries,
  listEntries,
  getEntry,
  getNamespaceCounts,
} from './entries-read.js';

export {
  checkAndMigrateLegacy,
  initializeMemoryDatabase,
  checkMemoryInitialization,
  applyTemporalDecay,
} from './init.js';

export { verifyMemoryInit } from './verify.js';

export { getLearningsOverview, type LearningsOverview } from './learnings-overview.js';

// ── Aggregate default export (unchanged shape — pre-#1203 importers that did
//    `import memoryInit from './memory-initializer.js'` keep working). ────────
import { initializeMemoryDatabase, checkMemoryInitialization, checkAndMigrateLegacy, applyTemporalDecay } from './init.js';
import { ensureSchemaColumns, MEMORY_SCHEMA_V3, getInitialMetadata } from './schema.js';
import { loadEmbeddingModel, generateEmbedding } from './embedding-model.js';
import { verifyMemoryInit } from './verify.js';
import { storeEntry, storeEntries, deleteEntry } from './entries-write.js';
import { searchEntries, listEntries, getEntry, getNamespaceCounts } from './entries-read.js';

export default {
  initializeMemoryDatabase,
  checkMemoryInitialization,
  checkAndMigrateLegacy,
  ensureSchemaColumns,
  applyTemporalDecay,
  loadEmbeddingModel,
  generateEmbedding,
  verifyMemoryInit,
  storeEntry,
  storeEntries,
  searchEntries,
  listEntries,
  getEntry,
  deleteEntry,
  getNamespaceCounts,
  MEMORY_SCHEMA_V3,
  getInitialMetadata
};
