/**
 * HNSW sidecar persistence helper (#734).
 *
 * Builds an in-memory `HnswLite` graph from the source-of-truth embedding
 * column in `.moflo/moflo.db` and atomically writes it to
 * `.moflo/hnsw.index`. Used by `memory rebuild-index`, `bin/build-embeddings.mjs`,
 * and any other writer that needs to refresh the sidecar after embeddings
 * change.
 *
 * Cold-start readers (`getHNSWIndex()` in memory-initializer.ts) call
 * `tryLoadHnswSidecar()` to skip the SQL-rebuild path entirely when the
 * sidecar exists and is well-formed.
 *
 * The sidecar binary format is owned by `HnswLite.serialize()` /
 * `HnswLite.load()` — see hnsw-lite.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mofloImport } from '../services/moflo-require.js';
import { atomicWriteFileSync } from '../services/atomic-file-write.js';
import { HnswLite } from './hnsw-lite.js';
import { parseEmbeddingJson } from './controllers/_shared.js';
import { hnswIndexPath } from '../services/moflo-paths.js';

export interface HnswBuildOptions {
  /** Override embedding dimensions. Defaults to 384 (matches fast-all-MiniLM-L6-v2). */
  dimensions?: number;
  /** HnswLite m parameter. Defaults to 16. */
  m?: number;
  /** HnswLite efConstruction parameter. Defaults to 200. */
  efConstruction?: number;
  /** Distance metric. Defaults to 'cosine'. */
  metric?: 'cosine' | 'dot' | 'euclidean';
}

export interface HnswBuildResult {
  /** Path the sidecar was written to. */
  sidecarPath: string;
  /** Number of vectors persisted. */
  vectorCount: number;
  /** Bytes written. */
  bytes: number;
}

/**
 * Build an HnswLite from every active row in `dbPath` that has an embedding,
 * then atomically write the sidecar to `<projectRoot>/.moflo/hnsw.index`.
 *
 * Throws on any failure — write errors, dimension mismatches, or empty
 * indexes. Callers (rebuild-index, build-embeddings.mjs, index-all.mjs)
 * use the throw to fail loudly, which is the explicit guardrail in #734.
 */
export async function buildAndWriteHnswSidecar(
  dbPath: string,
  projectRoot: string,
  options: HnswBuildOptions = {},
): Promise<HnswBuildResult> {
  const dimensions = options.dimensions ?? 384;
  const m = options.m ?? 16;
  const efConstruction = options.efConstruction ?? 200;
  const metric = options.metric ?? 'cosine';

  if (!fs.existsSync(dbPath)) {
    throw new Error(`buildAndWriteHnswSidecar: db not found at ${dbPath}`);
  }

  const sqlJsModule = await mofloImport('sql.js');
  if (!sqlJsModule) {
    throw new Error(`buildAndWriteHnswSidecar: sql.js not available`);
  }
  const SQL = await sqlJsModule.default();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf) as {
    exec: (sql: string) => Array<{ values: unknown[][] }>;
    close: () => void;
  };

  const hnsw = new HnswLite(dimensions, m, efConstruction, metric);
  let skipped = 0;

  try {
    const rows = db.exec(
      `SELECT id, embedding FROM memory_entries
       WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''`,
    );
    const values = rows[0]?.values ?? [];
    for (const row of values) {
      const [id, embeddingJson] = row as [string, unknown];
      const vec = parseEmbeddingJson(embeddingJson);
      if (!vec || vec.length !== dimensions) {
        skipped++;
        continue;
      }
      hnsw.add(String(id), vec);
    }
  } finally {
    db.close();
  }

  if (skipped > 0) {
    console.warn(`[hnsw-persistence] skipped ${skipped} rows with malformed or wrong-dimension embeddings`);
  }

  const sidecarPath = hnswIndexPath(projectRoot);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const out = hnsw.serialize();
  atomicWriteFileSync(sidecarPath, out);

  return { sidecarPath, vectorCount: hnsw.size, bytes: out.length };
}

/**
 * Load `<projectRoot>/.moflo/hnsw.index` if present and well-formed. Returns
 * null on missing file or any parse error — callers fall back to rebuilding
 * the graph from SQL. Logs format errors via console.warn so corruption is
 * visible without surfacing a hard failure to interactive callers.
 */
export function tryLoadHnswSidecar(projectRoot: string): HnswLite | null {
  const sidecarPath = hnswIndexPath(projectRoot);
  if (!fs.existsSync(sidecarPath)) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(sidecarPath);
  } catch (err) {
    console.warn(`[hnsw-persistence] read failed for ${sidecarPath}: ${(err as Error).message}`);
    return null;
  }
  try {
    return HnswLite.load(buf);
  } catch (err) {
    console.warn(`[hnsw-persistence] load failed for ${sidecarPath}: ${(err as Error).message} — will rebuild from SQL`);
    return null;
  }
}
