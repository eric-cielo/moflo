/**
 * Deterministic test-only embedding provider.
 *
 * Generates stable fixed-dimension vectors from a hash → sin() transform. The
 * resulting embeddings have no semantic meaning; they exist so unit/integration
 * tests can satisfy {@link IEmbeddingProvider} without loading an ONNX model.
 *
 * **NOT exported from the package** — this file lives under `tests/__mocks__/`
 * and is intentionally out of the published bundle (see epic #527).
 */

import type { IEmbeddingProvider } from '../../src/retriever.js';

export class DeterministicTestEmbeddingProvider implements IEmbeddingProvider {
  private dimensions: number;
  private cache = new Map<string, Float32Array>();

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const key = text.slice(0, 200);
    const existing = this.cache.get(key);
    if (existing) return existing;

    const embedding = this.hashEmbed(text);
    this.cache.set(key, embedding);
    return embedding;
  }

  async batchEmbed(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  private hashEmbed(text: string): Float32Array {
    const embedding = new Float32Array(this.dimensions);
    const normalized = text.toLowerCase().trim();

    for (let i = 0; i < this.dimensions; i++) {
      let hash = 0;
      for (let j = 0; j < normalized.length; j++) {
        hash = ((hash << 5) - hash + normalized.charCodeAt(j) * (i + 1)) | 0;
      }
      embedding[i] = (Math.sin(hash) + 1) / 2;
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

    return embedding;
  }
}
