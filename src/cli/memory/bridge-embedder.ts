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

import { createEmbeddingService } from '../embeddings/index.js';
import type { IEmbeddingService } from '../embeddings/types.js';

/** Canonical model label written into `memory_entries.embedding_model`. */
export const BRIDGE_EMBEDDING_MODEL = 'fast-all-MiniLM-L6-v2';

/** Canonical embedding dimension count for the bridge embedder. */
export const BRIDGE_EMBEDDING_DIMENSIONS = 384;

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
 * Minimal contract the bridge needs from an embedder. Tests inject a stub
 * via `setBridgeEmbedderForTest`. `embed()` MUST throw on failure — silent
 * `null` returns are what story #649 is fixing.
 */
export interface BridgeEmbedder {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
}

let cachedEmbedder: BridgeEmbedder | null = null;
let testOverride: BridgeEmbedder | null = null;

class LazyFastembedBridgeEmbedder implements BridgeEmbedder {
  readonly model = BRIDGE_EMBEDDING_MODEL;
  readonly dimensions = BRIDGE_EMBEDDING_DIMENSIONS;

  private service: IEmbeddingService | null = null;

  private getService(): IEmbeddingService {
    if (!this.service) {
      this.service = createEmbeddingService({
        provider: 'fastembed',
        dimensions: BRIDGE_EMBEDDING_DIMENSIONS,
      });
    }
    return this.service;
  }

  async embed(text: string): Promise<Float32Array> {
    const result = await this.getService().embed(text);
    const raw = (result as { embedding: Float32Array | number[] }).embedding;
    const vector = raw instanceof Float32Array ? raw : new Float32Array(raw);
    if (vector.length !== this.dimensions) {
      throw new Error(
        `bridge embedder produced ${vector.length}-dim vector, expected ${this.dimensions}`,
      );
    }
    return vector;
  }
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
