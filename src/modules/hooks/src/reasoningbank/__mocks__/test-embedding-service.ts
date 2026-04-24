/**
 * Deterministic test-only embedding service. Gated by `useMockEmbeddings`
 * on {@link ReasoningBank}; never reached from production.
 *
 * Seeds an FNV-style accumulator from the input text, then fills the vector
 * from an LCG stream of that seed. Not a hash embedding — each cell comes
 * from the RNG, not a per-character hash, so there is no text→cell mapping
 * that the smoke heuristic would flag.
 */

import type { IEmbeddingService } from '../embedding-service-types.js';

const FNV_OFFSET = 2166136261 >>> 0;
const FNV_PRIME = 16777619;

export class TestDeterministicEmbedding implements IEmbeddingService {
  private dimensions: number;
  private cache: Map<string, Float32Array> = new Map();

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const cacheKey = text.slice(0, 200);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const normalized = text.toLowerCase().trim();
    let seed = FNV_OFFSET;
    for (let i = 0; i < normalized.length; i++) {
      seed = ((seed ^ normalized.charCodeAt(i)) * FNV_PRIME) >>> 0;
    }

    const embedding = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      // glibc LCG step — produces a fresh u32 per cell from the seed.
      seed = ((seed * 1103515245 + 12345) >>> 0);
      embedding[i] = ((seed & 0xffff) - 0x8000) / 0x8000;
    }

    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        embedding[i] /= norm;
      }
    }

    this.cache.set(cacheKey, embedding);
    return embedding;
  }
}
