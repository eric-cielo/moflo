/**
 * Neural IEmbeddingProvider adapter for the guidance retriever.
 *
 * Wraps the local fastembed-backed service so the `ShardRetriever` can use
 * real neural semantics. Loading is lazy: the fastembed model is only fetched
 * when `embed()`/`batchEmbed()` is first called. There is no hash fallback
 * (see epic #527).
 */

// `createEmbeddingService` loaded lazily in getService() — see hooks-tools.ts.

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
  // Cache the init promise so concurrent embed/batchEmbed callers all await
  // the same createEmbeddingService rather than racing duplicates.
  private servicePromise: Promise<EmbeddingServiceLike> | null = null;

  async embed(text: string): Promise<Float32Array> {
    const svc = await this.getService();
    const result = await svc.embed(text);
    return toFloat32(result.embedding);
  }

  async batchEmbed(texts: string[]): Promise<Float32Array[]> {
    const svc = await this.getService();
    const result = await svc.embedBatch(texts);
    return result.embeddings.map(toFloat32);
  }

  private getService(): Promise<EmbeddingServiceLike> {
    if (!this.servicePromise) {
      this.servicePromise = (async () => {
        const { createEmbeddingService } = await import('../embeddings/embedding-service.js');
        return createEmbeddingService({
          provider: 'fastembed',
          dimensions: 384,
        }) as EmbeddingServiceLike;
      })();
    }
    return this.servicePromise;
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
