/**
 * Memory database initialization, legacy migration, and temporal decay.
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition). Builds a
 * fresh V3 database via the unified `openDaemonDatabase` factory, detects and
 * reports legacy installs, verifies initialization state, and applies
 * confidence decay to stale patterns.
 *
 * @module memory/init
 */

import * as fs from 'fs';
import * as path from 'path';
import { errorDetail } from '../shared/utils/error-detail.js';
import {
  MOFLO_DIR,
  legacyMemoryDbPath,
  memoryDbPath,
} from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';
import { getBridge } from './bridge-loader.js';
import { MEMORY_SCHEMA_V3, getInitialMetadata, type MemoryInitResult } from './schema.js';

/**
 * Check for legacy database installations and migrate if needed
 */
export async function checkAndMigrateLegacy(options: {
  dbPath: string;
  verbose?: boolean;
}): Promise<{
  needsMigration: boolean;
  legacyVersion?: string;
  legacyEntries?: number;
  migrated?: boolean;
  migratedCount?: number;
}> {
  const { dbPath, verbose = false } = options;

  // Check for legacy locations. `.swarm/memory.db` is the pre-#727 layout
  // primarily handled by the launcher's copy-verify-delete migration; this
  // probe still catches consumers whose launcher migration deferred. The
  // bare `memory.db` and `.claude/memory.db`/`data/memory.db` entries are
  // older still.
  const legacyPaths = [
    legacyMemoryDbPath(process.cwd()),
    path.join(process.cwd(), MOFLO_DIR, 'memory.db'),
    path.join(process.cwd(), 'memory.db'),
    path.join(process.cwd(), '.claude', 'memory.db'),
    path.join(process.cwd(), 'data', 'memory.db'),
  ];

  for (const legacyPath of legacyPaths) {
    if (fs.existsSync(legacyPath) && legacyPath !== dbPath) {
      try {
        const legacyDb = openDaemonDatabase(legacyPath);

        // Check if it has data
        const countResult = legacyDb.exec('SELECT COUNT(*) FROM memory_entries');
        const count = countResult[0]?.values[0]?.[0] as number || 0;

        // Get version if available
        let version = 'unknown';
        try {
          const versionResult = legacyDb.exec("SELECT value FROM metadata WHERE key='schema_version'");
          version = versionResult[0]?.values[0]?.[0] as string || 'unknown';
        } catch { /* no metadata table */ }

        legacyDb.close();

        if (count > 0) {
          return {
            needsMigration: true,
            legacyVersion: version,
            legacyEntries: count
          };
        }
      } catch {
        // Not a valid SQLite database, skip
      }
    }
  }

  return { needsMigration: false };
}

/**
 * ADR-053: Activate ControllerRegistry so AgentDB v3 controllers
 * (ReasoningBank, SkillLibrary, ExplainableRecall, etc.) are instantiated.
 *
 * Uses the memory-bridge's getControllerRegistry() which lazily creates
 * a singleton ControllerRegistry and initializes it with the given dbPath.
 * After this call, all enabled controllers are ready for immediate use.
 *
 * Failures are isolated: if the memory module or its native deps are not installed,
 * this returns an empty result without throwing.
 */
async function activateControllerRegistry(
  dbPath: string,
  verbose?: boolean,
): Promise<{ activated: string[]; failed: string[]; initTimeMs: number }> {
  const startTime = performance.now();
  const activated: string[] = [];
  const failed: string[] = [];

  try {
    const bridge = await getBridge();
    if (!bridge) {
      return { activated, failed, initTimeMs: performance.now() - startTime };
    }

    const registry = await bridge.getControllerRegistry(dbPath);
    if (!registry) {
      return { activated, failed, initTimeMs: performance.now() - startTime };
    }

    // Collect controller status from the registry
    if (typeof registry.listControllers === 'function') {
      const controllers = registry.listControllers();
      for (const ctrl of controllers) {
        if (ctrl.enabled) {
          activated.push(ctrl.name);
        } else {
          failed.push(ctrl.name);
        }
      }
    }

    if (verbose && activated.length > 0) {
      console.log(`ControllerRegistry: ${activated.length} controllers activated`);
    }
  } catch {
    // ControllerRegistry activation is best-effort
  }

  return { activated, failed, initTimeMs: performance.now() - startTime };
}

/**
 * Cross-platform safe unlink with a short EBUSY/EPERM retry loop. Windows
 * holds file handles briefly after process exit (and the consumer's
 * background daemon may still own the moflo.db handle when `memory init
 * --force` runs); on POSIX the first attempt always succeeds. Total wait
 * is bounded at ~750ms so we never paper over a real long-held handle.
 *
 * Used by `initializeMemoryDatabase` to ride out the daemon's brief handle
 * release race after `flo healer --kill-zombies`. See #1098 for the smoke
 * harness incident that drove this — the daemon's WAL+SHM file handles
 * weren't released by Windows for ~200ms after SIGKILL.
 */
function unlinkWithRetry(filePath: string): void {
  const delays = [0, 50, 100, 100, 100, 100, 100, 100, 50, 50]; // ~750ms total
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
    try {
      fs.unlinkSync(filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      // Only retry on the handle-release race codes. ENOENT means we've
      // already won (or the file was never there); EACCES could be a real
      // permission issue worth surfacing immediately.
      if (code === 'ENOENT') return;
      if (code !== 'EBUSY' && code !== 'EPERM') throw err;
    }
  }
  throw lastErr;
}

/**
 * Initialize the memory database via the unified node:sqlite factory.
 */
export async function initializeMemoryDatabase(options: {
  backend?: string;
  dbPath?: string;
  force?: boolean;
  verbose?: boolean;
  migrate?: boolean;
}): Promise<MemoryInitResult> {
  const {
    backend = 'hybrid',
    dbPath: customPath,
    force = false,
    verbose = false,
    migrate = true
  } = options;

  const dbPath = customPath || memoryDbPath(process.cwd());
  const dbDir = path.dirname(dbPath);

  try {
    // Create directory if needed
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Check for legacy installations
    if (migrate) {
      const legacyCheck = await checkAndMigrateLegacy({ dbPath, verbose });
      if (legacyCheck.needsMigration && verbose) {
        console.log(`Found legacy database (v${legacyCheck.legacyVersion}) with ${legacyCheck.legacyEntries} entries`);
      }
    }

    // Check existing database
    if (fs.existsSync(dbPath) && !force) {
      return {
        success: false,
        backend,
        dbPath,
        schemaVersion: '3.0.0',
        tablesCreated: [],
        indexesCreated: [],
        features: {
          vectorEmbeddings: false,
          patternLearning: false,
          temporalDecay: false,
          hnswIndexing: false,
          migrationTracking: false
        },
        error: 'Database already exists. Use --force to reinitialize.'
      };
    }

    // Force a clean slate so the new file gets fresh WAL state too.
    if (fs.existsSync(dbPath) && force) {
      // Windows EBUSY guard (#1098): the consumer's background daemon
      // (spawned by session-start during `npm install`) holds an open
      // file handle on moflo.db. `unlinkSync` would otherwise throw EBUSY
      // immediately — and the OS-level handle release race only resolves
      // after the daemon process actually exits, so a tight retry loop
      // can't outwait it. Stop the daemon first (graceful SIGTERM +
      // 1s grace + SIGKILL via `killBackgroundDaemon`), THEN retry the
      // unlink to ride out any residual handle-release lag.
      const projectRoot = path.dirname(path.dirname(dbPath));
      const { killBackgroundDaemon } = await import('../commands/daemon.js');
      try { await killBackgroundDaemon(projectRoot); }
      catch { /* best-effort; the retry below still gives us a budget */ }
      unlinkWithRetry(dbPath);
      // Also drop any sidecar WAL files so the next open doesn't replay
      // stale uncommitted transactions from the previous DB.
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = dbPath + suffix;
        if (fs.existsSync(sidecar)) {
          try { unlinkWithRetry(sidecar); } catch { /* best-effort */ }
        }
      }
    }

    const db = openDaemonDatabase(dbPath);
    try {
      // Execute schema
      db.run(MEMORY_SCHEMA_V3);
      // Insert initial metadata
      db.run(getInitialMetadata(backend));
    } finally {
      db.close();
    }

    // Also create schema file for reference
    const schemaPath = path.join(dbDir, 'schema.sql');
    fs.writeFileSync(schemaPath, MEMORY_SCHEMA_V3 + '\n' + getInitialMetadata(backend));

    // ADR-053: Activate ControllerRegistry so controllers (ReasoningBank,
    // SkillLibrary, ExplainableRecall, etc.) are instantiated during init
    const controllerResult = await activateControllerRegistry(dbPath, verbose);

    return {
      success: true,
      backend,
      dbPath,
      schemaVersion: '3.0.0',
      tablesCreated: [
        'memory_entries',
        'patterns',
        'pattern_history',
        'trajectories',
        'trajectory_steps',
        'migration_state',
        'sessions',
        'vector_indexes',
        'metadata'
      ],
      indexesCreated: [
        'idx_memory_namespace',
        'idx_memory_key',
        'idx_memory_type',
        'idx_memory_status',
        'idx_memory_created',
        'idx_memory_accessed',
        'idx_memory_owner',
        'idx_patterns_type',
        'idx_patterns_confidence',
        'idx_patterns_status',
        'idx_patterns_last_matched',
        'idx_pattern_history_pattern',
        'idx_steps_trajectory'
      ],
      features: {
        vectorEmbeddings: true,
        patternLearning: true,
        temporalDecay: true,
        hnswIndexing: true,
        migrationTracking: true
      },
      controllers: controllerResult,
    };
  } catch (error) {
    return {
      success: false,
      backend,
      dbPath,
      schemaVersion: '3.0.0',
      tablesCreated: [],
      indexesCreated: [],
      features: {
        vectorEmbeddings: false,
        patternLearning: false,
        temporalDecay: false,
        hnswIndexing: false,
        migrationTracking: false
      },
      error: errorDetail(error)
    };
  }
}

/**
 * Check if memory database is properly initialized
 */
export async function checkMemoryInitialization(dbPath?: string): Promise<{
  initialized: boolean;
  version?: string;
  backend?: string;
  features?: {
    vectorEmbeddings: boolean;
    patternLearning: boolean;
    temporalDecay: boolean;
  };
  tables?: string[];
}> {
  const path_ = dbPath || memoryDbPath(process.cwd());

  if (!fs.existsSync(path_)) {
    return { initialized: false };
  }

  try {
    const db = openDaemonDatabase(path_);

    // Check for metadata table
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = tables[0]?.values?.map(v => v[0] as string) || [];

    // Get version
    let version = 'unknown';
    let backend = 'unknown';
    try {
      const versionResult = db.exec("SELECT value FROM metadata WHERE key='schema_version'");
      version = versionResult[0]?.values[0]?.[0] as string || 'unknown';

      const backendResult = db.exec("SELECT value FROM metadata WHERE key='backend'");
      backend = backendResult[0]?.values[0]?.[0] as string || 'unknown';
    } catch {
      // Metadata table might not exist
    }

    db.close();

    return {
      initialized: true,
      version,
      backend,
      features: {
        vectorEmbeddings: tableNames.includes('vector_indexes'),
        patternLearning: tableNames.includes('patterns'),
        temporalDecay: tableNames.includes('pattern_history')
      },
      tables: tableNames
    };
  } catch {
    // Could not read database
    return { initialized: false };
  }
}

/**
 * Apply temporal decay to patterns
 * Reduces confidence of patterns that haven't been used recently
 */
export async function applyTemporalDecay(dbPath?: string): Promise<{
  success: boolean;
  patternsDecayed: number;
  error?: string;
}> {
  const path_ = dbPath || memoryDbPath(process.cwd());

  try {
    const db = openDaemonDatabase(path_);

    // Apply decay: confidence *= exp(-decay_rate * days_since_last_use)
    const now = Date.now();
    const decayQuery = `
      UPDATE patterns
      SET
        confidence = confidence * (1.0 - decay_rate * ((? - COALESCE(last_matched_at, created_at)) / 86400000.0)),
        updated_at = ?
      WHERE status = 'active'
        AND confidence > 0.1
        AND (? - COALESCE(last_matched_at, created_at)) > 86400000
    `;

    db.run(decayQuery, [now, now, now]);

    const changes = db.getRowsModified();
    db.close();

    return {
      success: true,
      patternsDecayed: changes
    };
  } catch (error) {
    return {
      success: false,
      patternsDecayed: 0,
      error: errorDetail(error)
    };
  }
}
