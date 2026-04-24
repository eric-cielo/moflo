/**
 * Test-only deterministic embedding service.
 *
 * ADR-EMB-001 forbids hash fallbacks on the production code path, so this
 * mock lives under __tests__/ and is excluded from the npm package. Tests
 * that need a synchronous, network-free embedder import directly from this
 * file; production callers get `FastembedEmbeddingService` via the factory.
 */

import { BaseEmbeddingService } from '../../embedding-service.js';
import type {
  EmbeddingProvider,
  EmbeddingResult,
  BatchEmbeddingResult,
  EmbeddingConfig,
  MockEmbeddingConfig,
} from '../../types.js';

export class MockEmbeddingService extends BaseEmbeddingService {
  // `'mock'` is intentionally not in `EmbeddingProvider` (production path is
  // neural-only per ADR-EMB-001); the cast here scopes the test-only string
  // to this class without leaking it into the shared union.
  readonly provider: EmbeddingProvider = 'mock' as unknown as EmbeddingProvider;
  private readonly dimensions: number;
  private readonly simulatedLatency: number;

  constructor(config: Partial<MockEmbeddingConfig> = {}) {
    const fullConfig: MockEmbeddingConfig = {
      provider: 'mock',
      dimensions: config.dimensions ?? 384,
      cacheSize: config.cacheSize ?? 1000,
      simulatedLatency: config.simulatedLatency ?? 0,
      enableCache: config.enableCache ?? true,
    };
    super(fullConfig as unknown as EmbeddingConfig);
    this.dimensions = fullConfig.dimensions!;
    this.simulatedLatency = fullConfig.simulatedLatency!;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const cached = this.cache.get(text);
    if (cached) {
      this.emitEvent({ type: 'cache_hit', text });
      return { embedding: cached, latencyMs: 0, cached: true };
    }

    this.emitEvent({ type: 'embed_start', text });
    const startTime = performance.now();

    if (this.simulatedLatency > 0) {
      await new Promise(resolve => setTimeout(resolve, this.simulatedLatency));
    }

    const embedding = deterministicEmbedding(text, this.dimensions);
    this.cache.set(text, embedding);

    const latencyMs = performance.now() - startTime;
    this.emitEvent({ type: 'embed_complete', text, latencyMs });

    return { embedding, latencyMs };
  }

  async embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    this.emitEvent({ type: 'batch_start', count: texts.length });
    const startTime = performance.now();

    const embeddings: Float32Array[] = [];
    let cacheHits = 0;

    for (const text of texts) {
      const cached = this.cache.get(text);
      if (cached) {
        embeddings.push(cached);
        cacheHits++;
      } else {
        const embedding = deterministicEmbedding(text, this.dimensions);
        this.cache.set(text, embedding);
        embeddings.push(embedding);
      }
    }

    const totalLatencyMs = performance.now() - startTime;
    this.emitEvent({ type: 'batch_complete', count: texts.length, latencyMs: totalLatencyMs });

    return {
      embeddings,
      totalLatencyMs,
      avgLatencyMs: totalLatencyMs / texts.length,
      cacheStats: {
        hits: cacheHits,
        misses: texts.length - cacheHits,
      },
    };
  }
}

function deterministicEmbedding(text: string, dimensions: number): Float32Array {
  const embedding = new Float32Array(dimensions);

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash = hash & hash;
  }

  for (let i = 0; i < dimensions; i++) {
    const seed = hash + i * 2654435761;
    const x = Math.sin(seed) * 10000;
    embedding[i] = x - Math.floor(x);
  }

  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  for (let i = 0; i < dimensions; i++) {
    embedding[i] /= norm;
  }

  return embedding;
}
