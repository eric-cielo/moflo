/**
 * Embeddings migration — barrel file.
 *
 * @module cli/embeddings/migration
 */

export {
  EMBEDDINGS_VERSION,
  type MigrateStoreOptions,
  type MigrationBatchUpdate,
  type MigrationCursor,
  type MigrationEmbedder,
  type MigrationItem,
  type MigrationProgress,
  type MigrationResult,
  type MigrationStore,
} from './types.js';

export { migrateStore } from './migrate-store.js';

export {
  InMemoryMigrationStore,
  type FailureInjector,
  type InMemoryItem,
  type InMemoryStoreOptions,
} from './in-memory-store.js';

export {
  EMBEDDINGS_VERSION_KEY,
  ensureMetadataTable,
  readEmbeddingsVersion,
  writeEmbeddingsVersion,
  ensureCursorTable,
  loadCursorRow,
  saveCursorRow,
  clearCursorRow,
  type SqlJsDatabase,
  type SqlJsStatement,
} from './sqljs-helpers.js';

export {
  runUpgrade,
  type UpgradeStep,
  type UpgradePlan,
  type UpgradeStatus,
  type UpgradeStepSummary,
  type UpgradeSummary,
  type UpgradeCoordinatorOptions,
} from './upgrade-coordinator.js';

export { UpgradeRenderer, type UpgradeRendererOptions } from './upgrade-renderer.js';

export {
  announcement,
  estimateMinutes,
  stepCompleted,
  finalSuccess,
  pauseOnInterrupt,
  batchExhaustionFailure,
  retryingBatch,
  formatDuration,
  BANNED_TECHNICAL_TERMS,
  type AnnouncementInput,
  type AnnouncementStep,
} from './upgrade-messages.js';
