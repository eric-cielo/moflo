/**
 * Memory + embeddings + semantic-search checks for `flo doctor`.
 *
 * `checkEmbeddings` is exported for the #639 stale-cache regression test
 * (src/cli/__tests__/commands/doctor-stale-vector-stats.test.ts).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { memoryDbCandidatePaths } from '../services/moflo-paths.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

/** Skew (cached / live count delta) above which the cache is treated as stale. */
const VECTOR_STATS_SKEW_WARN_THRESHOLD = 0.2;

/**
 * Open `dbPath` via moflo's bundled sql.js and return the count of memory_entries
 * rows that have an embedding. Returns null if sql.js can't be loaded, the file
 * isn't a v3 schema, or the query fails — every error is treated as "unknown
 * truth", letting the caller fall back to the cached stats rather than masking
 * a healthy DB as broken.
 */
async function countEmbeddedRowsFromDb(dbPath: string): Promise<number | null> {
  try {
    const { mofloImport } = await import('../services/moflo-require.js');
    const initSqlJs = (await mofloImport('sql.js'))?.default;
    if (!initSqlJs) return null;
    const SQL = await initSqlJs();
    const buffer = readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    try {
      const res = db.exec(
        "SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL AND embedding != ''",
      );
      const cell = res?.[0]?.values?.[0]?.[0];
      return typeof cell === 'number' ? cell : Number(cell ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function checkEmbeddings(): Promise<HealthCheck> {
  const liveDbPath = memoryDbCandidatePaths(process.cwd()).find((p) => existsSync(p));

  // 1. Fast path: read cached vector-stats.json if available
  const statsPath = join(process.cwd(), '.moflo', 'vector-stats.json');
  try {
    if (existsSync(statsPath)) {
      const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
      const count = stats.vectorCount ?? 0;
      const updatedAt = typeof stats.updatedAt === 'number' ? stats.updatedAt : 0;
      const hasHnsw = stats.hasHnsw ?? false;
      const dbSizeKB = stats.dbSizeKB ?? 0;

      // Skew check (#639): cross-check the cached vectorCount against the actual
      // DB; if they differ by more than VECTOR_STATS_SKEW_WARN_THRESHOLD, surface
      // a stale-cache warning rather than displaying a wrong number on the
      // statusline. Cheap signals first — opening memory.db via sql.js loads the
      // whole file. Skip the open when the cache was clearly written after the
      // last DB mutation (mtime check) AND the cached count is non-zero. The
      // count===0 case keeps the open because that's the observed #639 failure
      // mode (cache silently clobbered to zero).
      let dbMtimeMs = 0;
      if (liveDbPath) {
        try { dbMtimeMs = statSync(liveDbPath).mtimeMs; } catch { /* missing — handled below */ }
      }
      const cacheNewerThanDb = updatedAt > 0 && dbMtimeMs > 0 && updatedAt >= dbMtimeMs;
      if (liveDbPath && (count === 0 || !cacheNewerThanDb)) {
        const liveCount = await countEmbeddedRowsFromDb(liveDbPath);
        if (liveCount !== null) {
          const denom = Math.max(liveCount, 1);
          const skew = Math.abs(liveCount - count) / denom;
          if (skew > VECTOR_STATS_SKEW_WARN_THRESHOLD) {
            return {
              name: 'Embeddings',
              status: 'warn',
              message: `vector-stats cache is stale (cached ${count}, DB has ${liveCount} embedded rows — ${Math.round(skew * 100)}% skew)`,
              fix: 'node node_modules/moflo/bin/build-embeddings.mjs',
            };
          }
        }
      }

      if (count === 0) {
        return {
          name: 'Embeddings',
          status: 'warn',
          message: `Memory DB exists (${dbSizeKB} KB) but 0 vectors indexed — documents not embedded`,
          fix: 'npx moflo memory init --force && npx moflo embeddings init',
        };
      }

      const hnswLabel = hasHnsw ? ', HNSW' : '';
      return {
        name: 'Embeddings',
        status: 'pass',
        message: `${count} vectors indexed (${dbSizeKB} KB${hnswLabel})`,
      };
    }
  } catch {
    // Stats file unreadable — fall through to DB check
  }

  // 2. Check if memory DB file exists at all (reuse liveDbPath from above)
  const foundDbPath = liveDbPath ?? null;

  if (!foundDbPath) {
    return {
      name: 'Embeddings',
      status: 'warn',
      message: 'No memory database — embeddings not initialized',
      fix: 'npx moflo memory init --force',
    };
  }

  // 3. DB exists but no stats cache — try querying the DB for entry count
  try {
    const { checkMemoryInitialization } = await import('../memory/memory-initializer.js');
    const info = await checkMemoryInitialization(foundDbPath);
    if (!info.initialized) {
      return {
        name: 'Embeddings',
        status: 'warn',
        message: 'Memory DB exists but not properly initialized',
        fix: 'npx moflo memory init --force',
      };
    }
    const hasVectors = info.features?.vectorEmbeddings ?? false;
    if (!hasVectors) {
      return {
        name: 'Embeddings',
        status: 'warn',
        message: `Memory DB initialized (v${info.version}) but no vector_indexes table`,
        fix: 'npx moflo memory init --force && npx moflo embeddings init',
      };
    }
    return {
      name: 'Embeddings',
      status: 'pass',
      message: `Memory DB initialized (v${info.version}, vectors enabled)`,
    };
  } catch (sqlJsError) {
    // sql.js not available — fall back to file-size heuristic
    const sqlDetail = errorDetail(sqlJsError);
    try {
      const stats = statSync(foundDbPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        name: 'Embeddings',
        status: 'warn',
        message: `Memory DB exists (${sizeMB} MB) — cannot verify vectors (sql.js not available: ${sqlDetail})`,
        fix: 'npm install sql.js && npx moflo embeddings init',
      };
    } catch (statError) {
      return { name: 'Embeddings', status: 'warn', message: `Unable to check: sql.js failed (${sqlDetail}), stat failed (${errorDetail(statError)})` };
    }
  }
}

export async function checkSemanticQuality(): Promise<HealthCheck> {
  try {
    const { searchEntries } = await import('../memory/memory-initializer.js');
    const result = await searchEntries({
      query: 'test infrastructure health check',
      namespace: 'patterns',
      limit: 5,
      threshold: 0.1,
    });

    if (!result.success || result.results.length === 0) {
      return {
        name: 'Semantic Quality',
        status: 'warn',
        message: 'No search results (empty database or no patterns namespace)',
      };
    }

    const scores = result.results.map((r: { score: number }) => r.score);
    const allSame = scores.every((s: number) => s === scores[0]);
    const hasFallback = scores.some((s: number) => s === 0.5);

    if (hasFallback) {
      return {
        name: 'Semantic Quality',
        status: 'fail',
        message: `${scores.length} results, scores include 0.500 fallback (keyword-only, no embeddings)`,
        fix: 'Re-index with: npx moflo embeddings build --force',
      };
    }

    if (allSame && scores.length > 1) {
      return {
        name: 'Semantic Quality',
        status: 'warn',
        message: `${scores.length} results, all scores identical (${scores[0].toFixed(3)}) — degraded search`,
      };
    }

    const topScore = Math.max(...scores);
    return {
      name: 'Semantic Quality',
      status: topScore >= 0.3 ? 'pass' : 'warn',
      message: `${scores.length} results, top ${topScore.toFixed(3)}, varied (semantic search active)`,
    };
  } catch (e) {
    return {
      name: 'Semantic Quality',
      status: 'warn',
      message: `Check failed: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : 'error'}`,
    };
  }
}
