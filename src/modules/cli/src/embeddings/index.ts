/**
 * Embedding Service Module
 *
 * Neural embeddings only. Supported providers:
 * - `fastembed` — Qdrant's fastembed (ONNX) — the default and required runtime
 * - `transformers` — backwards-compatible alias that resolves to `fastembed`
 * - `openai` — remote API
 * - `mock` — deterministic test-only service (not reachable from the factory path)
 *
 * Additional features:
 * - Persistent SQLite cache
 * - Document chunking with overlap
 * - L2/L1/minmax/zscore normalization
 * - Hyperbolic embeddings (Poincaré ball)
 * - Neural substrate integration (drift, memory, swarm)
 *
 * @module cli/embeddings
 */

export * from './types.js';
export * from './embedding-service.js';

// Re-export commonly used items at top level
export {
  createEmbeddingService,
  createEmbeddingServiceAsync,
  getEmbedding,
  cosineSimilarity,
  euclideanDistance,
  dotProduct,
  computeSimilarity,
  OpenAIEmbeddingService,
} from './embedding-service.js';

export type { AutoEmbeddingConfig } from './embedding-service.js';

// Fastembed embedding service (ONNX-based neural embeddings via Qdrant's fastembed)
export { FastembedEmbeddingService } from './fastembed-embedding-service.js';

// Embeddings-version migration driver (resumable batch re-embed)
export {
  EMBEDDINGS_VERSION,
  EMBEDDINGS_VERSION_KEY,
  migrateStore,
  ensureCursorTable,
  ensureMetadataTable,
  readEmbeddingsVersion,
  writeEmbeddingsVersion,
  loadCursorRow,
  saveCursorRow,
  clearCursorRow,
  InMemoryMigrationStore,
  type MigrateStoreOptions,
  type MigrationBatchUpdate,
  type MigrationCursor,
  type MigrationEmbedder,
  type MigrationItem,
  type MigrationProgress,
  type MigrationResult,
  type MigrationStore,
  type InMemoryItem,
  type InMemoryStoreOptions,
  type FailureInjector,
  type SqlJsDatabase,
  type SqlJsStatement,
  runUpgrade,
  UpgradeRenderer,
  announcement,
  estimateMinutes,
  stepCompleted,
  finalSuccess,
  pauseOnInterrupt,
  batchExhaustionFailure,
  retryingBatch,
  formatDuration,
  BANNED_TECHNICAL_TERMS,
  type UpgradeStep,
  type UpgradePlan,
  type UpgradeStatus,
  type UpgradeStepSummary,
  type UpgradeSummary,
  type UpgradeCoordinatorOptions,
  type UpgradeRendererOptions,
  type AnnouncementInput,
  type AnnouncementStep,
} from './migration/index.js';

// Chunking utilities
export {
  chunkText,
  estimateTokens,
  reconstructFromChunks,
  type ChunkingConfig,
  type Chunk,
  type ChunkedDocument,
} from './chunking.js';

// Normalization utilities
export {
  l2Normalize,
  l2NormalizeInPlace,
  l1Normalize,
  minMaxNormalize,
  zScoreNormalize,
  normalize,
  normalizeBatch,
  l2Norm,
  isNormalized,
  centerEmbeddings,
  type NormalizationOptions,
} from './normalization.js';

// Hyperbolic embeddings (Poincaré ball)
export {
  euclideanToPoincare,
  poincareToEuclidean,
  hyperbolicDistance,
  mobiusAdd,
  mobiusScalarMul,
  hyperbolicCentroid,
  batchEuclideanToPoincare,
  pairwiseHyperbolicDistances,
  isInPoincareBall,
  type HyperbolicConfig,
} from './hyperbolic.js';

// Persistent cache
export {
  PersistentEmbeddingCache,
  isPersistentCacheAvailable,
  type PersistentCacheConfig as DiskCacheConfig,
  type PersistentCacheStats,
} from './persistent-cache.js';

// Neural substrate integration
export {
  NeuralEmbeddingService,
  createNeuralService,
  isNeuralAvailable,
  listEmbeddingModels,
  downloadEmbeddingModel,
  type DriftResult,
  type MemoryEntry,
  type AgentState,
  type CoherenceResult,
  type SubstrateHealth,
  type NeuralSubstrateConfig,
} from './neural-integration.js';

export type {
  EmbeddingProvider,
  EmbeddingConfig,
  OpenAIEmbeddingConfig,
  TransformersEmbeddingConfig,
  MockEmbeddingConfig,
  FastembedEmbeddingConfig,
  EmbeddingResult,
  BatchEmbeddingResult,
  IEmbeddingService,
  SimilarityMetric,
  SimilarityResult,
  NormalizationType,
  PersistentCacheConfig,
} from './types.js';
