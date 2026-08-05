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
 *
 * ## Incremental reconciliation (#1384)
 *
 * `syncHnswSidecar()` is the lazy counterpart to `buildAndWriteHnswSidecar()`:
 * it loads the existing graph and applies only the difference against the DB
 * rather than re-inserting every vector. `HnswLite.add()` runs a full scan per
 * insertion, so a wholesale rebuild is quadratic in store size — embedding one
 * new row used to re-index the entire store.
 *
 * Reconciling by id alone is not sufficient. Several writers replace a row's
 * embedding *in place* under the same id (`bridgeAddToHNSW`, the embeddings
 * migration's `updateBatch`, `build-embeddings`' `updateEmbedding` after a
 * `strip-context-preambles`-style NULL-out). An id-only diff would treat those
 * rows as "already indexed" and keep serving the superseded vector forever.
 *
 * So the sidecar is paired with a manifest (`.moflo/hnsw.manifest.json`) that
 * records, per id, a stamp derived from the embedding column itself —
 * `<length>:<first 64 characters>`. That is a pure function of the stored
 * vector, so it needs no cooperation from writers (an `updated_at` stamp would
 * silently miss any writer that forgets to bump it, and one such writer already
 * exists). Two genuinely different 384-float JSON payloads agreeing on both
 * total length and their leading floats is not a case that arises in practice,
 * and reading 64 characters per row keeps the check cheap enough to run every
 * session — reading whole embeddings back just to hash them would reintroduce a
 * per-session tax proportional to store size.
 *
 * The manifest is written after the sidecar. A crash between the two leaves a
 * manifest that no longer describes the graph, which the id-set cross-check
 * detects on the next run and heals with one full rebuild.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteFileSync } from '../services/atomic-file-write.js';
import { HnswLite } from './hnsw-lite.js';
import { parseEmbeddingJson } from './controllers/_shared.js';
import { hnswIndexPath } from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';

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
  /** Row ids dropped because their embedding was malformed or the wrong dimension. */
  skippedIds: string[];
}

export interface HnswSyncResult extends HnswBuildResult {
  /**
   * `full` — the graph was rebuilt from scratch; `incremental` — only the
   * difference was applied; `unchanged` — the sidecar already matched the DB
   * and nothing was written.
   */
  mode: 'full' | 'incremental' | 'unchanged';
  /** Why a full rebuild was chosen. Always set when `mode === 'full'`. */
  reason?: string;
  /** Vectors inserted during this sync. */
  added: number;
  /** Vectors evicted during this sync. */
  removed: number;
}

/** Manifest format version — bump to force every consumer through one rebuild. */
const MANIFEST_VERSION = 1;
const MANIFEST_FILENAME = 'hnsw.manifest.json';
/**
 * Characters of the embedding JSON folded into each stamp. 64 covers the first
 * ~7 floats at full precision, which is far more discriminating than needed.
 *
 * The residual hole, stated plainly: a replacement vector that matches its
 * predecessor's `updated_at`, total length, AND leading ~7 floats reads as
 * unchanged, and the superseded vector keeps being served. Every writer that
 * replaces an embedding sets `updated_at` (`build-embeddings`, `rebuild-index`,
 * `bridgeAddToHNSW`), so closing that requires two independent coincidences.
 * The alternative — reading whole embeddings back to hash them — puts a cost
 * proportional to store size on every session, which is the problem #1384
 * exists to remove.
 */
const STAMP_PREFIX_CHARS = 64;
/** How many skipped ids to name in the warning before truncating. */
const SKIPPED_IDS_LOGGED = 20;
/** Params per `IN (...)` batch — stays under the lowest SQLITE_MAX_VARIABLE_NUMBER. */
const ID_BATCH_SIZE = 400;

const EMBEDDED_ROWS_WHERE = `status = 'active' AND embedding IS NOT NULL AND embedding != ''`;
/** Single definition of the stamp's SQL projection — see `stampOf` for its shape. */
const STAMP_COLUMNS =
  `updated_at AS stamped_at, length(embedding) AS len, substr(embedding, 1, ${STAMP_PREFIX_CHARS}) AS head`;

/** The one place a stamp string is composed, so the two readers cannot drift. */
function stampOf(stampedAt: unknown, len: unknown, head: unknown): string {
  return `${String(stampedAt)}:${String(len)}:${String(head)}`;
}

interface SidecarManifest {
  version: number;
  dimensions: number;
  m: number;
  efConstruction: number;
  metric: string;
  /** Index-aligned with `stamps`. */
  ids: string[];
  stamps: string[];
}

interface StampedRow {
  id: string;
  stamp: string;
}

/**
 * Sibling of the sidecar. Exported for tests; no other subsystem reads it, so
 * it deliberately does not live in `services/moflo-paths.ts` with the paths
 * that are part of moflo's on-disk contract.
 */
export function hnswManifestPath(projectRoot: string): string {
  return path.join(path.dirname(hnswIndexPath(projectRoot)), MANIFEST_FILENAME);
}

function resolveOptions(options: HnswBuildOptions): Required<HnswBuildOptions> {
  return {
    dimensions: options.dimensions ?? 384,
    m: options.m ?? 16,
    efConstruction: options.efConstruction ?? 200,
    metric: options.metric ?? 'cosine',
  };
}

/**
 * Read `(id, stamp)` for every active row carrying an embedding. Only 64
 * characters of each embedding cross the SQLite boundary, so this stays cheap
 * on stores far larger than the one moflo dogfoods on.
 */
function readStampedRows(db: ReturnType<typeof openDaemonDatabase>): StampedRow[] {
  const rows = db.exec(
    `SELECT id, ${STAMP_COLUMNS} FROM memory_entries WHERE ${EMBEDDED_ROWS_WHERE}`,
  );
  const values = rows[0]?.values ?? [];
  return values.map((row) => {
    const [id, stampedAt, len, head] = row as [unknown, unknown, unknown, unknown];
    return { id: String(id), stamp: stampOf(stampedAt, len, head) };
  });
}

/** Fetch embeddings for a specific id set, batched to respect SQLite's param cap. */
function readEmbeddingsFor(
  db: ReturnType<typeof openDaemonDatabase>,
  ids: readonly string[],
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const batch = ids.slice(i, i + ID_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db.exec(
      `SELECT id, embedding FROM memory_entries
        WHERE ${EMBEDDED_ROWS_WHERE} AND id IN (${placeholders})`,
      batch,
    );
    for (const row of rows[0]?.values ?? []) {
      const [id, embedding] = row as [unknown, unknown];
      out.set(String(id), embedding);
    }
  }
  return out;
}

function warnSkipped(skippedIds: readonly string[]): void {
  if (skippedIds.length === 0) return;
  const shown = skippedIds.slice(0, SKIPPED_IDS_LOGGED).join(', ');
  const more = skippedIds.length > SKIPPED_IDS_LOGGED
    ? ` (+${skippedIds.length - SKIPPED_IDS_LOGGED} more)`
    : '';
  console.warn(
    `[hnsw-persistence] skipped ${skippedIds.length} row(s) with malformed or wrong-dimension embeddings: ${shown}${more}`,
  );
}

function writeSidecarAndManifest(
  hnsw: HnswLite,
  projectRoot: string,
  stamps: ReadonlyMap<string, string>,
): { sidecarPath: string; bytes: number } {
  const sidecarPath = hnswIndexPath(projectRoot);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const out = hnsw.serialize();
  atomicWriteFileSync(sidecarPath, out);

  // Manifest second: if the sidecar write throws we never advance the manifest,
  // so the pair on disk stays coherent.
  const params = hnsw.params;
  const ids: string[] = [];
  const stampList: string[] = [];
  for (const id of hnsw.ids()) {
    const stamp = stamps.get(id);
    if (stamp === undefined) continue;
    ids.push(id);
    stampList.push(stamp);
  }
  const manifest: SidecarManifest = {
    version: MANIFEST_VERSION,
    dimensions: params.dimensions,
    m: params.m,
    efConstruction: params.efConstruction,
    metric: params.metric,
    ids,
    stamps: stampList,
  };
  atomicWriteFileSync(hnswManifestPath(projectRoot), JSON.stringify(manifest));
  return { sidecarPath, bytes: out.length };
}

/**
 * Build an HnswLite from every active row in `dbPath` that has an embedding,
 * then atomically write the sidecar to `<projectRoot>/.moflo/hnsw.index` and
 * its reconciliation manifest alongside it.
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
  const { dimensions, m, efConstruction, metric } = resolveOptions(options);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`buildAndWriteHnswSidecar: db not found at ${dbPath}`);
  }

  // node:sqlite via the unified factory — Phase 5 (#1084) replaced the
  // sql.js readFileSync + new SQL.Database round-trip with a direct open
  // through openDaemonDatabase. WAL writes incrementally so there's nothing
  // to flush back here; the sidecar persistence below is unaffected.
  const db = openDaemonDatabase(dbPath);

  const hnsw = new HnswLite(dimensions, m, efConstruction, metric);
  const stamps = new Map<string, string>();
  const skippedIds: string[] = [];

  try {
    const rows = db.exec(
      `SELECT id, embedding, ${STAMP_COLUMNS} FROM memory_entries WHERE ${EMBEDDED_ROWS_WHERE}`,
    );
    const values = rows[0]?.values ?? [];
    for (const row of values) {
      const [rawId, embeddingJson, stampedAt, len, head] =
        row as [unknown, unknown, unknown, unknown, unknown];
      const id = String(rawId);
      const vec = parseEmbeddingJson(embeddingJson);
      if (!vec || vec.length !== dimensions) {
        skippedIds.push(id);
        continue;
      }
      hnsw.add(id, vec);
      stamps.set(id, stampOf(stampedAt, len, head));
    }
  } finally {
    db.close();
  }

  warnSkipped(skippedIds);

  const { sidecarPath, bytes } = writeSidecarAndManifest(hnsw, projectRoot, stamps);
  return { sidecarPath, vectorCount: hnsw.size, bytes, skippedIds };
}

/**
 * Bring `<projectRoot>/.moflo/hnsw.index` into agreement with `dbPath` by
 * applying only the difference (#1384).
 *
 * Rows already indexed with an unchanged embedding are left completely alone —
 * their vectors are never re-read, re-decoded, or re-inserted. Rows that
 * departed the DB (or lost their embedding) are evicted, which is what stops
 * edited chunks — `applyIncrementalChunks` gives a changed chunk a brand-new id
 * — from accumulating orphaned vectors that keep answering searches.
 *
 * Falls back to a full rebuild, with the reason recorded on the result and
 * logged, when reconciliation cannot be trusted: `force`, no sidecar, an
 * unreadable sidecar, a missing/corrupt manifest, a manifest that no longer
 * matches the sidecar's contents, or a change to dimensions/metric/m/
 * efConstruction.
 */
export async function syncHnswSidecar(
  dbPath: string,
  projectRoot: string,
  options: HnswBuildOptions & { force?: boolean } = {},
): Promise<HnswSyncResult> {
  const { dimensions, m, efConstruction, metric } = resolveOptions(options);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`syncHnswSidecar: db not found at ${dbPath}`);
  }

  const fullRebuild = async (reason: string): Promise<HnswSyncResult> => {
    const built = await buildAndWriteHnswSidecar(dbPath, projectRoot, options);
    return { ...built, mode: 'full', reason, added: built.vectorCount, removed: 0 };
  };

  if (options.force) return fullRebuild('forced');

  const hnsw = tryLoadHnswSidecar(projectRoot);
  if (!hnsw) {
    return fullRebuild(
      fs.existsSync(hnswIndexPath(projectRoot)) ? 'sidecar unreadable' : 'no sidecar',
    );
  }

  const manifest = readManifest(projectRoot);
  if (!manifest) return fullRebuild('no usable manifest');

  const params = hnsw.params;
  if (
    manifest.dimensions !== dimensions || params.dimensions !== dimensions ||
    manifest.m !== m || params.m !== m ||
    manifest.efConstruction !== efConstruction || params.efConstruction !== efConstruction ||
    manifest.metric !== metric || params.metric !== metric
  ) {
    return fullRebuild('index parameters changed');
  }

  // The manifest is only meaningful if it still describes this exact graph.
  const known = new Map<string, string>();
  for (let i = 0; i < manifest.ids.length; i++) known.set(manifest.ids[i], manifest.stamps[i]);
  if (known.size !== hnsw.size) return fullRebuild('manifest does not match sidecar');
  for (const id of known.keys()) {
    if (!hnsw.has(id)) return fullRebuild('manifest does not match sidecar');
  }

  const db = openDaemonDatabase(dbPath);
  let added = 0;
  let removed = 0;
  const skippedIds: string[] = [];
  try {
    const current = readStampedRows(db);
    const currentStamps = new Map(current.map((r) => [r.id, r.stamp]));

    // In the DB but absent from the sidecar, or present with a superseded
    // vector — the only ids whose embeddings get read at all.
    const toAdd: string[] = [];
    for (const { id, stamp } of current) {
      if (known.get(id) !== stamp) toAdd.push(id);
    }
    // In the sidecar but gone from the DB (deleted, or its embedding cleared).
    const toRemove: string[] = [];
    for (const id of known.keys()) {
      if (!currentStamps.has(id)) toRemove.push(id);
    }

    if (toAdd.length === 0 && toRemove.length === 0) {
      return {
        sidecarPath: hnswIndexPath(projectRoot),
        vectorCount: hnsw.size,
        bytes: 0,
        skippedIds: [],
        mode: 'unchanged',
        added: 0,
        removed: 0,
      };
    }

    for (const id of toRemove) {
      hnsw.remove(id);
      known.delete(id);
      removed++;
    }

    const embeddings = readEmbeddingsFor(db, toAdd);
    for (const id of toAdd) {
      // Absent from the second query means the row was deleted between the two
      // reads — a benign race with a concurrent writer, not corruption. Evict
      // it and stay quiet; the next run picks up whatever the writer left.
      const vanished = !embeddings.has(id);
      const vec = vanished ? null : parseEmbeddingJson(embeddings.get(id));
      if (!vec || vec.length !== dimensions) {
        if (!vanished) skippedIds.push(id);
        // A row whose vector no longer parses must not keep its old entry.
        if (hnsw.has(id)) {
          hnsw.remove(id);
          removed++;
        }
        known.delete(id);
        continue;
      }
      // Replace rather than overwrite so the previous vector's back-edges go
      // with it — `add()` on an existing id would leave them dangling.
      if (hnsw.has(id)) hnsw.remove(id);
      hnsw.add(id, vec);
      known.set(id, currentStamps.get(id)!);
      added++;
    }
  } finally {
    db.close();
  }

  warnSkipped(skippedIds);

  const { sidecarPath, bytes } = writeSidecarAndManifest(hnsw, projectRoot, known);
  return {
    sidecarPath,
    vectorCount: hnsw.size,
    bytes,
    skippedIds,
    mode: 'incremental',
    added,
    removed,
  };
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

/**
 * Load the reconciliation manifest. Returns null when it is absent, unreadable,
 * from another format version, or structurally invalid — every one of which
 * sends `syncHnswSidecar` down the full-rebuild path.
 */
function readManifest(projectRoot: string): SidecarManifest | null {
  const manifestPath = hnswManifestPath(projectRoot);
  if (!fs.existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.warn(`[hnsw-persistence] manifest unreadable at ${manifestPath}: ${(err as Error).message}`);
    return null;
  }
  const m = parsed as Partial<SidecarManifest>;
  if (
    !m || m.version !== MANIFEST_VERSION ||
    typeof m.dimensions !== 'number' || typeof m.m !== 'number' ||
    typeof m.efConstruction !== 'number' || typeof m.metric !== 'string' ||
    !Array.isArray(m.ids) || !Array.isArray(m.stamps) ||
    m.ids.length !== m.stamps.length
  ) {
    return null;
  }
  return m as SidecarManifest;
}
