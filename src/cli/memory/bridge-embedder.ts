/**
 * Bridge embedder — single source of truth for embedding generation
 * inside the sql.js bridge path (`bridgeStoreEntry`, `bridgeGenerateEmbedding`,
 * `bridgeAddToHNSW`).
 *
 * Pre-#648 the bridge read `ctx.mofloDb.embedder`, which is undefined on the
 * `SqlJsHandle` shape — every "successful embed" branch was unreachable, so
 * every store inserted a null-embedded row tagged with the schema default
 * (`'local'`). The successful-path label (`'Xenova/all-MiniLM-L6-v2'`) was
 * dead code. See issue #648 / story #649.
 *
 * This module owns the lazily-initialized `FastembedEmbeddingService` and
 * exposes the canonical model label (`'fast-all-MiniLM-L6-v2'`) so every
 * write path tags rows the same way the indexer (`bin/build-embeddings.mjs`)
 * does. Failures throw — never silently degrade.
 *
 * @module v3/cli/bridge-embedder
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// `createEmbeddingService` loaded lazily in getService() — see hooks-tools.ts.
import type { IEmbeddingService } from '../embeddings/types.js';
import {
  CANONICAL_EMBEDDING_DIMENSIONS,
  CANONICAL_EMBEDDING_MODEL,
} from '../embeddings/migration/types.js';
import { toFloat32 } from './controllers/_shared.js';
import { errorDetail } from '../shared/utils/error-detail.js';

/**
 * Canonical model label written into `memory_entries.embedding_model`.
 * Aliased from {@link CANONICAL_EMBEDDING_MODEL} for backward compatibility
 * with bridge-side callers; new code in `services/` and `embeddings/` should
 * import the canonical name directly to avoid sideways `memory/` coupling.
 */
export const BRIDGE_EMBEDDING_MODEL = CANONICAL_EMBEDDING_MODEL;

/** Canonical embedding dimension count for the bridge embedder. */
export const BRIDGE_EMBEDDING_DIMENSIONS = CANONICAL_EMBEDDING_DIMENSIONS;

/**
 * `embedding_model` value for rows where the caller intentionally skipped
 * embedding generation (e.g. `generateEmbeddingFlag: false`). Distinct from
 * the schema default `'local'`, which #649 retired as ambiguous — the doctor
 * check in #651 needs this clean separation to tell intentional skips from
 * silent failures.
 */
export const EMBEDDING_MODEL_OPT_OUT = 'none';

/**
 * The legacy schema default for `memory_entries.embedding_model`. New rows
 * should never be tagged with this value — exported only so audits and the
 * #651 doctor check can detect pre-fix residue without re-typing the literal.
 */
export const EMBEDDING_MODEL_LEGACY_DEFAULT = 'local';

/**
 * Namespaces that skip embedding generation in the bridge write path. Rows
 * land with both `embedding` and `embedding_model` NULL (distinct from the
 * opt-out path which still tags rows with `'none'`).
 *
 * Members:
 * - `hive-mind`     — MCP broadcast traffic (msg:*, agent_join, consensus_propose)
 * - `tasklist`      — Spell run records (sp-*) written by spells/core/runner.ts + daemon-dashboard.ts
 * - `epic-state`    — Epic progress (epic-N, story-M) written by commands/epic.ts
 * - `test-bridge-fix` — Single 2026-04-23 row left over from a one-off test
 *
 * See story #729 for the source-trace and rationale. The session-start
 * launcher only purges {@link PURGE_ON_SESSION_START_NAMESPACES} — a strict
 * subset that *excludes* `tasklist`, because the dashboard's Flo Runs tab
 * (`daemon-dashboard.ts handleSpells`) reads tasklist; purging it on every
 * session would empty the tab between sessions (#968).
 */
export const EPHEMERAL_NAMESPACES: ReadonlySet<string> = new Set([
  'hive-mind',
  'tasklist',
  'epic-state',
  'test-bridge-fix',
]);

/**
 * Subset of {@link EPHEMERAL_NAMESPACES} that the session-start launcher
 * hard-purges via `services/ephemeral-namespace-purge.ts`. Excludes
 * `tasklist` — those rows back the dashboard's "Flo Runs" tab and are
 * trimmed by row-count retention instead of bulk purge (#968).
 */
export const PURGE_ON_SESSION_START_NAMESPACES: ReadonlySet<string> = new Set([
  'hive-mind',
  'epic-state',
  'test-bridge-fix',
]);

/**
 * Maximum number of `tasklist` rows kept across session restarts. The
 * session-start retention pass deletes oldest rows beyond this cap, so the
 * dashboard's "Flo Runs" tab shows recent history without unbounded growth
 * (#968). Sized for ~2 weeks of /flo activity at typical use.
 */
export const TASKLIST_RETENTION_CAP = 200;

/**
 * Minimal contract the bridge needs from an embedder. Tests inject a stub
 * via `setBridgeEmbedderForTest`. `embed()` MUST throw on failure — silent
 * `null` returns are what story #649 is fixing.
 *
 * `embedBatch()` is optional so existing test stubs that only implement
 * `embed()` keep working — callers fall back to N x embed() when absent
 * (see `bridgeEmbedAll()` below).
 */
export interface BridgeEmbedder {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch?(texts: string[]): Promise<Float32Array[]>;
}

let cachedEmbedder: BridgeEmbedder | null = null;
let testOverride: BridgeEmbedder | null = null;

class LazyFastembedBridgeEmbedder implements BridgeEmbedder {
  readonly model = BRIDGE_EMBEDDING_MODEL;
  readonly dimensions = BRIDGE_EMBEDDING_DIMENSIONS;

  // Cache the init promise so concurrent embed() callers all await the same
  // createEmbeddingService rather than racing duplicate instances.
  private servicePromise: Promise<IEmbeddingService> | null = null;

  private getService(): Promise<IEmbeddingService> {
    if (!this.servicePromise) {
      this.servicePromise = (async () => {
        const { createEmbeddingService } = await import('../embeddings/embedding-service.js');
        return createEmbeddingService({
          provider: 'fastembed',
          dimensions: BRIDGE_EMBEDDING_DIMENSIONS,
        });
      })();
    }
    return this.servicePromise;
  }

  async embed(text: string): Promise<Float32Array> {
    const service = await this.getService();
    const result = await service.embed(text);
    return this.assertDim(toFloat32((result as { embedding: Float32Array | number[] }).embedding));
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const service = await this.getService();
    const result = await service.embedBatch(texts);
    const raws = (result as { embeddings: Array<Float32Array | number[]> }).embeddings;
    return raws.map((raw, idx) => this.assertDim(toFloat32(raw), idx));
  }

  private assertDim(vector: Float32Array, idx?: number): Float32Array {
    if (vector.length !== this.dimensions) {
      const where = idx === undefined ? '' : ` at index ${idx}`;
      throw new Error(
        `bridge embedder produced ${vector.length}-dim vector${where}, expected ${this.dimensions}`,
      );
    }
    return vector;
  }
}

/**
 * Resolve the row's embedding fields from either a precomputed vector or a
 * live `embedder.embed()` call. Returns `{ ok: false }` on embedder failure
 * so callers can translate the error into their own result shape — bridge
 * stores return from the function, bulk stores push to a results array.
 */
export type ResolvedEmbedding =
  | { ok: true; json: string; dimensions: number; model: string }
  | { ok: true; json: null; dimensions: 0; model: string | null }
  | { ok: false; reason: string };

/**
 * Build the `embedding` field of a store-entry response from a resolved
 * embedding. Returns `undefined` for skip paths (opt-out and ephemeral) so
 * the caller can pass it straight through.
 */
export function embeddingResponseFrom(
  resolved: Extract<ResolvedEmbedding, { ok: true }>,
): { dimensions: number; model: string } | undefined {
  // json !== null narrows to the embedded variant where model is `string`.
  return resolved.json !== null
    ? { dimensions: resolved.dimensions, model: resolved.model }
    : undefined;
}

export async function resolveBridgeEmbedding(
  value: string,
  precomputed: Float32Array | number[] | undefined,
  generateEmbeddingFlag: boolean | undefined,
  namespace?: string,
): Promise<ResolvedEmbedding> {
  // Ephemeral namespaces (run-tracking, never user knowledge) skip embeddings
  // unconditionally — even precomputed vectors are dropped. Result row has
  // `embedding IS NULL` and `embedding_model IS NULL`. See #729.
  if (namespace && EPHEMERAL_NAMESPACES.has(namespace)) {
    return { ok: true, json: null, dimensions: 0, model: null };
  }
  const wantsEmbedding = generateEmbeddingFlag !== false && value.length > 0;
  if (!wantsEmbedding) {
    return { ok: true, json: null, dimensions: 0, model: EMBEDDING_MODEL_OPT_OUT };
  }
  const embedder = getBridgeEmbedder();
  if (precomputed) {
    const vector = toFloat32(precomputed);
    return { ok: true, json: JSON.stringify(Array.from(vector)), dimensions: vector.length, model: embedder.model };
  }
  try {
    const vector = await embedder.embed(value);
    return { ok: true, json: JSON.stringify(Array.from(vector)), dimensions: vector.length, model: embedder.model };
  } catch (err) {
    return { ok: false, reason: errorDetail(err) };
  }
}

/**
 * Default chunk size for {@link bridgeEmbedAll}. fastembed processes a batch
 * serially under the hood, so the only thing a giant single call buys is
 * higher peak memory and worse error granularity. 256 keeps peak memory at
 * ~256 x 384 floats x 4B = 384 KiB while staying well above per-call overhead.
 */
export const BRIDGE_EMBED_CHUNK_SIZE = 256;

/**
 * Embed a batch of texts using the active bridge embedder. Internally chunks
 * to {@link BRIDGE_EMBED_CHUNK_SIZE} so callers don't have to think about
 * batch limits — pretrain (~50 texts) does one chunk; a hypothetical 10k
 * caller does 40 chunks with bounded peak memory.
 *
 * Uses `embedBatch()` when the embedder implements it (one model call per
 * chunk), otherwise falls back to N sequential `embed()` calls so test stubs
 * without batch support still work.
 */
export async function bridgeEmbedAll(
  texts: string[],
  chunkSize: number = BRIDGE_EMBED_CHUNK_SIZE,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const embedder = getBridgeEmbedder();
  const size = Math.max(1, chunkSize);
  const out: Float32Array[] = new Array(texts.length);

  if (typeof embedder.embedBatch === 'function') {
    for (let start = 0; start < texts.length; start += size) {
      const chunk = texts.slice(start, start + size);
      const vecs = await embedder.embedBatch(chunk);
      for (let i = 0; i < vecs.length; i++) out[start + i] = vecs[i];
    }
    return out;
  }

  for (let i = 0; i < texts.length; i++) out[i] = await embedder.embed(texts[i]);
  return out;
}

/**
 * Resolve the bridge embedder. Returns the test override if one was
 * installed via `setBridgeEmbedderForTest`, otherwise the lazily-built
 * fastembed singleton.
 */
export function getBridgeEmbedder(): BridgeEmbedder {
  if (testOverride) return testOverride;
  if (!cachedEmbedder) cachedEmbedder = new LazyFastembedBridgeEmbedder();
  return cachedEmbedder;
}

/**
 * Install a stub embedder for tests. Pass `null` to clear and fall back to
 * the production fastembed implementation.
 */
export function setBridgeEmbedderForTest(impl: BridgeEmbedder | null): void {
  testOverride = impl;
}

/**
 * Drop the cached production embedder — exposed so tests that exercised
 * the real fastembed path can reset it without leaking state into the next
 * test.
 */
export function _resetBridgeEmbedderCacheForTest(): void {
  cachedEmbedder = null;
}
