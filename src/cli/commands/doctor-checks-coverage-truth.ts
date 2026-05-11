/**
 * Embedding Coverage Truth doctor check (epic #1054.S5 / #1059).
 *
 * Stricter complement to `checkEmbeddings`: any disagreement between
 * `.moflo/vector-stats.json` and the live DB count fails the check and
 * forces doctor to report the LOWER number. The existing check allowed a
 * 20% skew tolerance — that tolerance is what let #1054.repro-1 keep saying
 * 100% even after the daemon-tick clobber drove the live count below the
 * cached count.
 *
 * @module cli/commands/doctor-checks-coverage-truth
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { memoryDbCandidatePaths } from '../services/moflo-paths.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

interface CoverageReading {
  cached: number | null;
  live: number | null;
  missing: number | null;
}

async function liveEmbeddedRowCount(dbPath: string): Promise<number | null> {
  try {
    const { mofloImport } = await import('../services/moflo-require.js');
    const initSqlJs = (await mofloImport('sql.js'))?.default;
    if (!initSqlJs) return null;
    const SQL = await initSqlJs();
    const buffer = readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    try {
      const res = db.exec(
        "SELECT COUNT(*) FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''",
      );
      const cell = res?.[0]?.values?.[0]?.[0];
      const n = typeof cell === 'number' ? cell : Number(cell ?? 0);
      return Number.isFinite(n) ? n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readCachedStats(cwd: string): { vectorCount: number; missing: number } | null {
  const p = join(cwd, '.moflo', 'vector-stats.json');
  if (!existsSync(p)) return null;
  try {
    const stats = JSON.parse(readFileSync(p, 'utf8'));
    return {
      vectorCount: typeof stats.vectorCount === 'number' ? stats.vectorCount : 0,
      missing: typeof stats.missing === 'number' ? stats.missing : 0,
    };
  } catch {
    return null;
  }
}

export async function readCoverage(cwd: string = process.cwd()): Promise<CoverageReading> {
  const cached = readCachedStats(cwd);
  const dbPath = memoryDbCandidatePaths(cwd).find((p) => existsSync(p)) ?? null;
  const live = dbPath ? await liveEmbeddedRowCount(dbPath) : null;
  return {
    cached: cached?.vectorCount ?? null,
    live,
    missing: cached?.missing ?? null,
  };
}

/**
 * Refuses to report 100% when the on-disk cache disagrees with the live DB.
 * Always reports the LOWER number with the discrepancy noted.
 *
 * Pass cases:
 *   - No cache + no DB: nothing to compare, neutral pass
 *   - Cache and live agree exactly
 * Warn cases:
 *   - Cache present but DB unreadable (sql.js missing, etc.) — defer to the
 *     existing checkEmbeddings instead of double-warning
 * Fail cases:
 *   - Cache and live disagree → report the lower value, note discrepancy
 */
export async function checkEmbeddingCoverageTruth(cwd: string = process.cwd()): Promise<HealthCheck> {
  const name = 'Embedding Coverage Truth';
  try {
    const { cached, live, missing } = await readCoverage(cwd);

    if (cached === null && live === null) {
      return { name, status: 'pass', message: 'No memory database or cache yet — nothing to reconcile' };
    }

    if (cached !== null && live === null) {
      // Cache exists but live count unreadable — checkEmbeddings owns the
      // "sql.js unavailable" diagnosis; this check stays neutral so we don't
      // double-warn.
      return {
        name,
        status: 'pass',
        message: `Cache reports ${cached} vectors (live count unverified — sql.js unavailable)`,
      };
    }

    if (cached === null && live !== null) {
      return {
        name,
        status: 'warn',
        message: `Live DB has ${live} embedded rows but no .moflo/vector-stats.json cache exists`,
        fix: 'node node_modules/moflo/bin/build-embeddings.mjs',
      };
    }

    // Both readings present.
    const cachedN = cached ?? 0;
    const liveN = live ?? 0;
    if (cachedN === liveN) {
      const totalRows = liveN + (missing ?? 0);
      const pct = totalRows > 0 ? Math.round((liveN / totalRows) * 100) : 100;
      return {
        name,
        status: 'pass',
        message: `${liveN} vectors confirmed live ${
          missing && missing > 0 ? `(${pct}% of ${totalRows}, ${missing} missing)` : '(100%)'
        }`,
      };
    }

    const lower = Math.min(cachedN, liveN);
    const direction = cachedN > liveN ? 'cache higher than DB' : 'DB higher than cache';
    return {
      name,
      status: 'fail',
      message:
        `Coverage mismatch: cache=${cachedN}, live=${liveN} (${direction}); ` +
        `reporting the lower value ${lower}. ` +
        `Likely cause: writer clobber or stale cache (#1054 bug class).`,
      fix: 'node node_modules/moflo/bin/build-embeddings.mjs',
    };
  } catch (e) {
    return {
      name,
      status: 'warn',
      message: `Unable to verify coverage: ${errorDetail(e, { firstLineOnly: true })}`,
    };
  }
}
