/**
 * Embedding hygiene doctor check (#651) — catches the three regressions
 * documented in #648:
 *
 *   1. Banned hash-tagged rows (`embedding_model LIKE 'domain-aware-hash%'`).
 *      ADR-EMB-001 retires the hash fallback; surviving rows are residue
 *      from a pre-ban moflo install.
 *   2. Silent-failure marker (`embedding_model = 'local' AND embedding IS
 *      NULL`). Pre-#649 this was the schema default for null-embedded rows
 *      that should never have been inserted; #651 doctor surfaces them so
 *      they don't accumulate again.
 *   3. Mixed-model active set — more than one neural model present at the
 *      same time. Cosine similarity is meaningful within an embedding
 *      space, not across them, so search precision degrades when the table
 *      mixes (e.g.) `Xenova/all-MiniLM-L6-v2` and `fast-all-MiniLM-L6-v2`
 *      vectors. The Story-2 self-healing migration converges every active
 *      row on the canonical label; this check verifies it actually did.
 *
 * Lives next to the doctor command rather than in `doctor.ts` to keep that
 * file under the 500-line decomposition target.
 *
 * @module cli/commands/doctor-embedding-hygiene
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync } from 'fs';
import { join } from 'path';

import { CANONICAL_EMBEDDING_MODEL } from '../embeddings/migration/types.js';
import { mofloImport } from '../services/moflo-require.js';

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

/**
 * Known neural-model labels that all share the all-MiniLM-L6-v2 384-dim
 * vector space. The Story-2 migration retags any of these to the
 * canonical label; presence of more than one indicates incomplete
 * convergence.
 */
const KNOWN_NEURAL_LABELS: ReadonlySet<string> = new Set([
  CANONICAL_EMBEDDING_MODEL,
  'fastembed/all-MiniLM-L6-v2',
  'Xenova/all-MiniLM-L6-v2',
]);

/** Non-neural sentinels that don't count toward the mixed-model check. */
const SENTINEL_LABELS: ReadonlySet<string> = new Set(['none', 'local']);

interface ModelGroup {
  model: string;
  count: number;
  hasNullEmbedding: boolean;
}

/**
 * Scan the bridge memory.db for the three #648 regression markers. Pass when
 * either no DB exists yet, or every active row is on the canonical model
 * with no banned/null-failure residue.
 */
export async function checkEmbeddingHygiene(): Promise<HealthCheck> {
  const dbPath = resolveMemoryDb();
  if (dbPath === null) {
    // Nothing to scan — checkEmbeddings already reports the missing DB.
    return {
      name: 'Embedding hygiene',
      status: 'pass',
      message: 'No memory database — nothing to check',
    };
  }

  const groups = await loadModelGroups(dbPath);
  if (groups === null) {
    return {
      name: 'Embedding hygiene',
      status: 'pass',
      message: 'Cannot inspect memory DB (sql.js not available)',
    };
  }
  if (groups.length === 0) {
    return {
      name: 'Embedding hygiene',
      status: 'pass',
      message: 'No active rows — nothing to check',
    };
  }

  const issues: string[] = [];

  // (1) Banned hash-tagged rows.
  const banned = groups.filter((g) => g.model.startsWith('domain-aware-hash'));
  const bannedTotal = banned.reduce((sum, g) => sum + g.count, 0);
  if (bannedTotal > 0) {
    const detail = banned
      .map((g) => `${g.model}=${g.count}`)
      .join(', ');
    issues.push(`${bannedTotal} row(s) tagged with banned hash model (${detail})`);
  }

  // (2) Silent-failure marker — local + NULL embedding.
  const localNull = groups.find((g) => g.model === 'local' && g.hasNullEmbedding);
  if (localNull && localNull.count > 0) {
    issues.push(
      `${localNull.count} row(s) with embedding_model='local' AND embedding IS NULL ` +
        '(silent producer failure marker — see #649)',
    );
  }

  // (3) Mixed neural models.
  const neuralPresent = groups
    .filter((g) => KNOWN_NEURAL_LABELS.has(g.model))
    .map((g) => g.model);
  if (neuralPresent.length > 1) {
    const detail = groups
      .filter((g) => KNOWN_NEURAL_LABELS.has(g.model))
      .map((g) => `${g.model}=${g.count}`)
      .join(', ');
    issues.push(`mixed neural models present (${detail}) — cosine search precision degrades`);
  }

  // (4) Unknown labels (not target, not legacy-neural, not sentinel) —
  // surface but don't elevate to warn unless the count is non-trivial. New
  // legitimate models will land here too; this is defense in depth, not a
  // strict invariant.
  const unknown = groups.filter(
    (g) => !KNOWN_NEURAL_LABELS.has(g.model) &&
      !SENTINEL_LABELS.has(g.model) &&
      !g.model.startsWith('domain-aware-hash'),
  );
  if (unknown.length > 0) {
    const total = unknown.reduce((sum, g) => sum + g.count, 0);
    const detail = unknown.map((g) => `${g.model}=${g.count}`).join(', ');
    issues.push(`${total} row(s) with unrecognised embedding_model (${detail})`);
  }

  if (issues.length === 0) {
    const onTarget = groups.find((g) => g.model === CANONICAL_EMBEDDING_MODEL)?.count ?? 0;
    return {
      name: 'Embedding hygiene',
      status: 'pass',
      message: `${onTarget} row(s) on ${CANONICAL_EMBEDDING_MODEL}, no residue`,
    };
  }

  return {
    name: 'Embedding hygiene',
    status: 'warn',
    message: issues.join('; '),
    fix: 'npx moflo embeddings init  # runs the self-healing repair migration',
  };
}

function resolveMemoryDb(): string | null {
  const candidates = [
    join(process.cwd(), '.swarm', 'memory.db'),
    join(process.cwd(), '.claude-flow', 'memory.db'),
    join(process.cwd(), 'data', 'memory.db'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function loadModelGroups(dbPath: string): Promise<ModelGroup[] | null> {
  const fs = await import('fs');
  let initSqlJs: any;
  try {
    initSqlJs = (await mofloImport('sql.js'))?.default;
  } catch {
    return null;
  }
  if (!initSqlJs) return null;

  let db: any;
  try {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } catch {
    return null;
  }

  try {
    // Probe for the v3 schema columns this check reads. If memory_entries
    // doesn't exist or lacks embedding_model, treat it as "nothing to check"
    // rather than fail — older DBs predate #648.
    let hasSchema = false;
    try {
      const stmt = db.prepare(`PRAGMA table_info(memory_entries)`);
      const cols = new Set<string>();
      while (stmt.step()) {
        const row = stmt.get();
        if (Array.isArray(row) && typeof row[1] === 'string') cols.add(row[1]);
      }
      stmt.free();
      hasSchema = ['embedding', 'embedding_model', 'status'].every((c) => cols.has(c));
    } catch {
      hasSchema = false;
    }
    if (!hasSchema) return [];

    const groups: ModelGroup[] = [];
    const result = db.exec(
      `SELECT
         COALESCE(embedding_model, 'NULL') AS model,
         COUNT(*) AS n,
         SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) AS null_count
       FROM memory_entries
       WHERE status = 'active'
       GROUP BY model`,
    );
    if (!result || result.length === 0) return [];
    const rows = result[0]?.values ?? [];
    for (const row of rows) {
      groups.push({
        model: String(row[0]),
        count: Number(row[1]),
        hasNullEmbedding: Number(row[2]) > 0,
      });
    }
    return groups;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}
