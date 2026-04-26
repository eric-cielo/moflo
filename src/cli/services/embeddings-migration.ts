/**
 * Idempotent embeddings-version migration for moflo's memory.db.
 *
 * Runs the story-2 driver (`runUpgrade`) with the story-3 UX on any DB whose
 * stored `embeddings_version` is below the current runtime version OR whose
 * active rows include any non-target `embedding_model` (#650 — repair mode).
 * Safe to call on every session start — returns fast when the DB is fully
 * on-target, when sql.js isn't available, or when the schema is too old.
 *
 * Lives in `services/` so it has no dependency on the CLI command machinery.
 * That lets `bin/session-start-launcher.mjs` dynamic-import it and run the
 * migration in foreground with piped stdio — so the renderer's TTY bar /
 * non-TTY status lines actually reach the user.
 *
 * @module cli/services/embeddings-migration
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mofloImport } from './moflo-require.js';
import { atomicWriteFileSync } from './atomic-file-write.js';
// EMBEDDINGS_VERSION is a number constant in a leaf types module — pulling it
// eagerly is cheap. The heavy imports (fastembed wrapper, upgrade renderer,
// etc.) stay deferred behind the early returns so session-start stays fast.
import {
  CANONICAL_EMBEDDING_MODEL,
  EMBEDDINGS_VERSION,
} from '../embeddings/migration/types.js';

export interface RunEmbeddingsMigrationOptions {
  /** Path to the memory DB. Defaults to `<cwd>/.swarm/memory.db`. */
  dbPath?: string;
  /** Output stream for the renderer. Defaults to `process.stderr`. */
  out?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Force TTY mode regardless of `out.isTTY`. */
  isTTY?: boolean;
}

/**
 * Run the migration if and only if it's needed.
 *
 * Returns `true` when the driver completed with status `'completed'` and
 * wrote the new embeddings back to the DB file. Returns `false` in every
 * other case — no DB found, sql.js unavailable, DB schema lacks embedding
 * columns, already at target version, or the driver aborted / failed
 * mid-run. Errors propagate to the caller.
 */
export async function runEmbeddingsMigrationIfNeeded(
  options: RunEmbeddingsMigrationOptions = {},
): Promise<boolean> {
  const fs = await import('fs');
  const path = await import('path');

  const dbPath = path.resolve(
    options.dbPath ?? path.join(process.cwd(), '.swarm', 'memory.db'),
  );
  if (!fs.existsSync(dbPath)) return false;

  const initSqlJs = (await mofloImport('sql.js'))?.default;
  if (!initSqlJs) return false;

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  try {
    // Probe: only migrate DBs that carry the v3 memory_entries schema. The
    // old `embedding` column alone isn't enough — the migration writes back
    // `content` and `embedding_dimensions`, so those must exist too, or the
    // SELECT / UPDATE will throw at runtime.
    if (!hasV3MemorySchema(db)) {
      return false;
    }

    const { SqlJsMemoryEntriesStore } = await import('./sqljs-migration-store.js');
    // `targetModel` makes the store filter rows by `embedding_model != target`
    // and re-tag them on update. Combined with the version + eligibility probe
    // below this turns the migration into a self-healing pass — no separate
    // "repair" command needed for #648's surviving Xenova / hash / 'local'
    // residue. See the constructor's docstring for full semantics.
    const store = new SqlJsMemoryEntriesStore(db, path.basename(dbPath), {
      targetModel: CANONICAL_EMBEDDING_MODEL,
    });

    // Two-stage probe — keep session-start cost flat regardless of DB size.
    //
    //   1. `getVersion()` — single-row metadata SELECT, sub-millisecond.
    //   2. `hasIneligibleRows()` — `SELECT 1 ... LIMIT 1` against
    //      `memory_entries`, bounded regardless of row count.
    //
    // The clean common case (v2 stamped, all rows on target) costs both
    // probes plus zero work. The migrate-store driver bumps the version on
    // a successful 0-item run — so a fresh DB or a stale-stamp DB falls
    // through naturally without a special-case write here.
    const currentVersion = await store.getVersion();
    if (currentVersion !== null && currentVersion >= EMBEDDINGS_VERSION) {
      if (!(await store.hasIneligibleRows())) return false;
    }

    const { createEmbeddingService, runUpgrade } = await import('../embeddings/index.js');
    const service = createEmbeddingService({
      provider: 'fastembed',
      dimensions: 384,
    });

    const out = options.out ?? process.stderr;
    const isTTY = options.isTTY ?? (out as { isTTY?: boolean }).isTTY ?? false;

    const summary = await runUpgrade({
      out,
      isTTY,
      plan: {
        steps: [
          {
            label: 'Re-index memory so search can find things again',
            store,
            embedder: {
              async embedBatch(texts: string[]): Promise<Float32Array[]> {
                const result = await service.embedBatch(texts);
                return result.embeddings.map((vec) =>
                  vec instanceof Float32Array ? vec : new Float32Array(vec),
                );
              },
            },
          },
        ],
      },
    });

    if (summary.status === 'completed') {
      // `db.export()` returns a Uint8Array; `writeFileSync` accepts it directly,
      // so no Buffer.from() copy. Atomic temp-file + rename so SIGINT mid-write
      // cannot truncate memory.db — see atomic-file-write.ts.
      atomicWriteFileSync(dbPath, db.export());
      return true;
    }

    return false;
  } finally {
    db.close();
  }
}

/**
 * V3 memory schema probe. Checks that every column the migration touches
 * exists on `memory_entries`. If any is missing, the DB is from an older or
 * unrelated schema and we skip — not our table to rewrite.
 */
function hasV3MemorySchema(db: unknown): boolean {
  const required = ['id', 'content', 'embedding', 'embedding_dimensions'];
  try {
    const stmt = (db as {
      prepare(sql: string): {
        step(): boolean;
        get(): unknown[];
        free(): void;
      };
    }).prepare(`PRAGMA table_info(memory_entries)`);
    const present = new Set<string>();
    while (stmt.step()) {
      const row = stmt.get();
      // PRAGMA table_info returns [cid, name, type, notnull, dflt_value, pk]
      if (Array.isArray(row) && typeof row[1] === 'string') {
        present.add(row[1]);
      }
    }
    stmt.free();
    return required.every((col) => present.has(col));
  } catch {
    return false;
  }
}
