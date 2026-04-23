/**
 * Embeddings migration — barrel file.
 *
 * @module @moflo/embeddings/migration
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
  MockBatchEmbedder,
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
