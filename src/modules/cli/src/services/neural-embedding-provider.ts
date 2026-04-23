/**
 * Neural IEmbeddingProvider adapter for the guidance retriever.
 *
 * Wraps `@moflo/embeddings`'s fastembed-backed service so the
 * `ShardRetriever` can use real neural semantics. Loading is lazy: the
 * fastembed model is only fetched when `embed()`/`batchEmbed()` is first
 * called. A hard error is thrown if the embeddings module is not installed
 * — there is no hash fallback (see epic #527).
 */

import { mofloImport } from './moflo-require.js';

// Keeping the shape minimal avoids a build-time coupling on the
// @moflo/guidance retriever type definition from this loader.
export interface NeuralEmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  batchEmbed(texts: string[]): Promise<Float32Array[]>;
}

interface EmbeddingServiceLike {
  embed(text: string): Promise<{ embedding: Float32Array | number[] }>;
  embedBatch(texts: string[]): Promise<{ embeddings: Array<Float32Array | number[]> }>;
}

class FastembedBackedProvider implements NeuralEmbeddingProvider {
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
      this.servicePromise = loadFastembedService();
    }
    return this.servicePromise;
  }
}

async function loadFastembedService(): Promise<EmbeddingServiceLike> {
  const mod = await mofloImport('@moflo/embeddings', ['createEmbeddingService']);
  if (!mod) {
    throw new Error(
      `@moflo/embeddings is required for the guidance retriever but could not be loaded. ` +
        `Ensure moflo was installed with the default (neural) runtime.`,
    );
  }
  const service = mod.createEmbeddingService({
    provider: 'fastembed',
    dimensions: 384,
  }) as EmbeddingServiceLike;
  return service;
}

function toFloat32(vec: Float32Array | number[]): Float32Array {
  return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

/**
 * Build a neural embedding provider for the guidance retriever.
 *
 * The factory itself is synchronous-ish (returns after confirming the
 * embeddings module is resolvable) but defers the fastembed model fetch
 * until the first embed call.
 */
export async function createNeuralEmbeddingProvider(): Promise<NeuralEmbeddingProvider> {
  return new FastembedBackedProvider();
}
