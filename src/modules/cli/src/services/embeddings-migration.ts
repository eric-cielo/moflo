/**
 * Idempotent embeddings-version migration for moflo's memory.db.
 *
 * Runs the story-2 driver (`runUpgrade`) with the story-3 UX on any DB whose
 * stored `embeddings_version` is below the current runtime version. Safe to
 * call on every session start — returns fast when the DB is already
 * up-to-date or when `@moflo/embeddings` / `sql.js` aren't installed.
 *
 * Lives in `services/` so it has no dependency on the CLI command machinery.
 * That lets `bin/session-start-launcher.mjs` dynamic-import it and run the
 * migration in foreground with piped stdio — so the renderer's TTY bar /
 * non-TTY status lines actually reach the user.
 *
 * @module @moflo/cli/services/embeddings-migration
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mofloImport } from './moflo-require.js';

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
 * other case — no DB found, embeddings package missing, DB schema lacks
 * embedding columns, already at target version, or the driver aborted /
 * failed mid-run. Errors propagate to the caller.
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

  let embeddings: unknown;
  try {
    embeddings = await import('@moflo/embeddings');
  } catch {
    return false;
  }

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
    const store = new SqlJsMemoryEntriesStore(db, path.basename(dbPath));

    const currentVersion = await store.getVersion();
    const targetVersion = (embeddings as { EMBEDDINGS_VERSION: number }).EMBEDDINGS_VERSION;
    if (currentVersion !== null && currentVersion >= targetVersion) {
      return false;
    }

    const service = (embeddings as {
      createEmbeddingService: (c: unknown) => {
        embedBatch(texts: string[]): Promise<{ embeddings: Array<Float32Array | number[]> }>;
      };
    }).createEmbeddingService({
      provider: 'fastembed',
      dimensions: 384,
    });

    const runUpgrade = (embeddings as {
      runUpgrade: (opts: unknown) => Promise<{ status: string; errors: readonly string[] }>;
    }).runUpgrade;

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
      const exported = db.export();
      fs.writeFileSync(dbPath, Buffer.from(exported));
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
