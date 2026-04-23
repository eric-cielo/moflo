/**
 * Deterministic test-only embedding service. Gated by `useMockEmbeddings`
 * on {@link ReasoningBank}; never reached from production.
 *
 * Near-duplicate of `guidance/tests/__mocks__/deterministic-embedding-provider.ts`
 * — cross-package DRY extraction tracked by #558.
 */

import type { IEmbeddingService } from '../embedding-service-types.js';

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

    const embedding = new Float32Array(this.dimensions);
    const normalized = text.toLowerCase().trim();

    for (let i = 0; i < this.dimensions; i++) {
      let h = 0;
      for (let j = 0; j < normalized.length; j++) {
        h = ((h << 5) - h + normalized.charCodeAt(j) * (i + 1)) | 0;
      }
      embedding[i] = (Math.sin(h) + 1) / 2;
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
