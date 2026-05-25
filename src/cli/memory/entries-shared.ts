/**
 * Internal helpers shared by the memory entry read + write paths.
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition). These were
 * file-private helpers in the monolith; they live here so `entries-read.ts`
 * and `entries-write.ts` share ONE copy (and one `_routingFaultLogged`
 * latch) without re-exporting them from the public barrel.
 *
 * @module memory/entries-shared
 */

import * as fs from 'fs';
import * as path from 'path';
import { errorDetail } from '../shared/utils/error-detail.js';
import { hnswIndexPath } from '../services/moflo-paths.js';
import { writeVectorStatsJson } from './bridge-core.js';

// #981 — daemon-write-client throws are a contract violation (it's documented
// as never-throw). When a throw escapes anyway, log to stderr ONCE per process
// and fall through to the direct-write path. Silent swallow would hide bugs;
// per-call logging would spam.
let _routingFaultLogged = false;
export function logRoutingFault(err: unknown): void {
  if (_routingFaultLogged) return;
  _routingFaultLogged = true;
  process.stderr.write(
    `moflo: daemon-write-client routing fault (#981, falling back to direct write): ${errorDetail(err)}\n`,
  );
}

/**
 * Write vector-stats.json cache for the statusline (no subprocess needed).
 * Called after memory store in the direct-write fallback path. The bridge
 * path goes through refreshVectorStatsCache() in bridge-core.ts instead.
 * @param dbPath - path to the SQLite database file
 * @param stats  - exact counts from a db query already in progress (required —
 *                 making this optional caused issue #639 by silently writing 0)
 */
export function writeVectorStatsCache(
  dbPath: string,
  stats: { vectorCount: number; namespaces: number; missing?: number },
): void {
  try {
    const fileStat = fs.statSync(dbPath);
    const dbSizeKB = Math.floor(fileStat.size / 1024);
    const { vectorCount, namespaces, missing = 0 } = stats;

    const dbDir = path.dirname(dbPath);
    const projectDir = path.dirname(dbDir); // .moflo (or legacy .swarm) -> project root
    let hasHnsw = false;
    try { fs.statSync(hnswIndexPath(projectDir)); hasHnsw = true; }
    catch { /* nope */ }

    writeVectorStatsJson(projectDir, { vectorCount, missing, dbSizeKB, namespaces, hasHnsw });
  } catch { /* Non-fatal */ }
}

/**
 * Optimized cosine similarity
 * V8 JIT-friendly - avoids manual unrolling which can hurt performance
 * ~0.5μs per 384-dim vector comparison
 */
export function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;

  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;

  // Simple loop - V8 optimizes this well
  for (let i = 0; i < len; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  // Combined sqrt for slightly better performance
  const mag = Math.sqrt(normA * normB);
  return mag === 0 ? 0 : dot / mag;
}
