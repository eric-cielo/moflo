/**
 * Neural IEmbeddingProvider adapter for the guidance retriever.
 *
 * Wraps the local fastembed-backed service so the `ShardRetriever` can use
 * real neural semantics. Loading is lazy: the fastembed model is only fetched
 * when `embed()`/`batchEmbed()` is first called. There is no hash fallback
 * (see epic #527).
 */

import { createEmbeddingService } from '../embeddings/index.js';

// Keeping the shape minimal avoids a build-time coupling on the
// guidance retriever type definition from this loader.
export interface NeuralEmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  batchEmbed(texts: string[]): Promise<Float32Array[]>;
}

interface EmbeddingServiceLike {
  embed(text: string): Promise<{ embedding: Float32Array | number[] }>;
  embedBatch(texts: string[]): Promise<{ embeddings: Array<Float32Array | number[]> }>;
}

class FastembedBackedProvider implements NeuralEmbeddingProvider {
  private service: EmbeddingServiceLike | null = null;

  async embed(text: string): Promise<Float32Array> {
    const svc = this.getService();
    const result = await svc.embed(text);
    return toFloat32(result.embedding);
  }

  async batchEmbed(texts: string[]): Promise<Float32Array[]> {
    const svc = this.getService();
    const result = await svc.embedBatch(texts);
    return result.embeddings.map(toFloat32);
  }

  private getService(): EmbeddingServiceLike {
    if (!this.service) {
      this.service = createEmbeddingService({
        provider: 'fastembed',
        dimensions: 384,
      }) as EmbeddingServiceLike;
    }
    return this.service;
  }
}

function toFloat32(vec: Float32Array | number[]): Float32Array {
  return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

/**
 * Build a neural embedding provider for the guidance retriever.
 *
 * Defers the fastembed model fetch until the first embed call.
 */
export async function createNeuralEmbeddingProvider(): Promise<NeuralEmbeddingProvider> {
  return new FastembedBackedProvider();
}
