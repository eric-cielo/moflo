/**
 * Embedding Service Implementation
 *
 * Neural embeddings only. Supported providers:
 * - `fastembed` — local ONNX via Qdrant's `fastembed` package (required hard dep)
 * - `transformers` — backwards-compatible alias for `fastembed`
 * - `openai` — remote API
 * - `mock` — deterministic test-only service, never reachable from production factories
 *
 * There is no hash fallback. If the selected provider cannot initialize, the
 * factory throws — silent degradation to hash-based pseudo-embeddings is a
 * correctness hazard (see ADR-G002, ADR-G026, epic #527).
 *
 * Performance Targets:
 * - Single embedding: <100ms (API), <50ms (local)
 * - Batch embedding: <500ms for 10 items
 * - Cache hit: <1ms
 */

import { EventEmitter } from 'events';
import type {
  EmbeddingProvider,
  EmbeddingConfig,
  OpenAIEmbeddingConfig,
  TransformersEmbeddingConfig,
  MockEmbeddingConfig,
  FastembedEmbeddingConfig,
  EmbeddingResult,
  BatchEmbeddingResult,
  IEmbeddingService,
  EmbeddingEvent,
  EmbeddingEventListener,
  SimilarityMetric,
  SimilarityResult,
  NormalizationType,
  PersistentCacheConfig,
} from './types.js';
import { normalize } from './normalization.js';
import { PersistentEmbeddingCache } from './persistent-cache.js';

// ============================================================================
// LRU Cache Implementation
// ============================================================================

class LRUCache<K, V> {
  private cache: Map<K, V> = new Map();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
      this.hits++;
      return value;
    }
    this.misses++;
    return undefined;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  get hitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate,
    };
  }
}

// ============================================================================
// Base Embedding Service
// ============================================================================

export abstract class BaseEmbeddingService extends EventEmitter implements IEmbeddingService {
  abstract readonly provider: EmbeddingProvider;
  protected cache: LRUCache<string, Float32Array>;
  protected persistentCache: PersistentEmbeddingCache | null = null;
  protected embeddingListeners: Set<EmbeddingEventListener> = new Set();
  protected normalizationType: NormalizationType;

  constructor(protected readonly config: EmbeddingConfig) {
    super();
    this.cache = new LRUCache(config.cacheSize ?? 1000);
    this.normalizationType = config.normalization ?? 'none';

    if (config.persistentCache?.enabled) {
      const pcConfig: PersistentCacheConfig = config.persistentCache;
      this.persistentCache = new PersistentEmbeddingCache({
        dbPath: pcConfig.dbPath ?? '.cache/embeddings.db',
        maxSize: pcConfig.maxSize ?? 10000,
        ttlMs: pcConfig.ttlMs,
      });
    }
  }

  abstract embed(text: string): Promise<EmbeddingResult>;
  abstract embedBatch(texts: string[]): Promise<BatchEmbeddingResult>;

  protected applyNormalization(embedding: Float32Array): Float32Array {
    if (this.normalizationType === 'none') {
      return embedding;
    }
    return normalize(embedding, { type: this.normalizationType });
  }

  protected async checkPersistentCache(text: string): Promise<Float32Array | null> {
    if (!this.persistentCache) return null;
    return this.persistentCache.get(text);
  }

  protected async storePersistentCache(text: string, embedding: Float32Array): Promise<void> {
    if (!this.persistentCache) return;
    await this.persistentCache.set(text, embedding);
  }

  protected emitEvent(event: EmbeddingEvent): void {
    for (const listener of this.embeddingListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in embedding event listener:', error);
      }
    }
    this.emit(event.type, event);
  }

  addEventListener(listener: EmbeddingEventListener): void {
    this.embeddingListeners.add(listener);
  }

  removeEventListener(listener: EmbeddingEventListener): void {
    this.embeddingListeners.delete(listener);
  }

  clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.emitEvent({ type: 'cache_eviction', size });
  }

  getCacheStats() {
    const stats = this.cache.getStats();
    return {
      size: stats.size,
      maxSize: stats.maxSize,
      hitRate: stats.hitRate,
    };
  }

  async shutdown(): Promise<void> {
    this.clearCache();
    this.embeddingListeners.clear();
  }
}

// ============================================================================
// OpenAI Embedding Service
// ============================================================================

export class OpenAIEmbeddingService extends BaseEmbeddingService {
  readonly provider: EmbeddingProvider = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: OpenAIEmbeddingConfig) {
    super(config);
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseURL = config.baseURL ?? 'https://api.openai.com/v1/embeddings';
    this.timeout = config.timeout ?? 30000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const cached = this.cache.get(text);
    if (cached) {
      this.emitEvent({ type: 'cache_hit', text });
      return { embedding: cached, latencyMs: 0, cached: true };
    }

    this.emitEvent({ type: 'embed_start', text });
    const startTime = performance.now();

    try {
      const response = await this.callOpenAI([text]);
      const embedding = new Float32Array(response.data[0].embedding);
      this.cache.set(text, embedding);

      const latencyMs = performance.now() - startTime;
      this.emitEvent({ type: 'embed_complete', text, latencyMs });

      return {
        embedding,
        latencyMs,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.emitEvent({ type: 'embed_error', text, error: message });
      throw new Error(`OpenAI embedding failed: ${message}`);
    }
  }

  async embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    this.emitEvent({ type: 'batch_start', count: texts.length });
    const startTime = performance.now();

    const cached: Array<{ index: number; embedding: Float32Array }> = [];
    const uncached: Array<{ index: number; text: string }> = [];

    texts.forEach((text, index) => {
      const cachedEmbedding = this.cache.get(text);
      if (cachedEmbedding) {
        cached.push({ index, embedding: cachedEmbedding });
        this.emitEvent({ type: 'cache_hit', text });
      } else {
        uncached.push({ index, text });
      }
    });

    let apiEmbeddings: Float32Array[] = [];
    let usage = { promptTokens: 0, totalTokens: 0 };

    if (uncached.length > 0) {
      const response = await this.callOpenAI(uncached.map(u => u.text));
      apiEmbeddings = response.data.map(d => new Float32Array(d.embedding));

      uncached.forEach((item, i) => {
        this.cache.set(item.text, apiEmbeddings[i]);
      });

      usage = {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      };
    }

    const embeddings: Array<Float32Array> = new Array(texts.length);
    cached.forEach(c => {
      embeddings[c.index] = c.embedding;
    });
    uncached.forEach((u, i) => {
      embeddings[u.index] = apiEmbeddings[i];
    });

    const totalLatencyMs = performance.now() - startTime;
    this.emitEvent({ type: 'batch_complete', count: texts.length, latencyMs: totalLatencyMs });

    return {
      embeddings,
      totalLatencyMs,
      avgLatencyMs: totalLatencyMs / texts.length,
      usage,
      cacheStats: {
        hits: cached.length,
        misses: uncached.length,
      },
    };
  }

  private async callOpenAI(texts: string[]): Promise<{
    data: Array<{ embedding: number[] }>;
    usage?: { prompt_tokens: number; total_tokens: number };
  }> {
    const config = this.config as OpenAIEmbeddingConfig;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(this.baseURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            dimensions: config.dimensions,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }

        return await response.json() as {
          data: Array<{ embedding: number[] }>;
          usage?: { prompt_tokens: number; total_tokens: number };
        };
      } catch (error) {
        if (attempt === this.maxRetries - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
      }
    }

    throw new Error('Max retries exceeded');
  }
}

// ============================================================================
// Mock Embedding Service (TEST-ONLY — never returned by createEmbeddingService)
// ============================================================================

/**
 * Deterministic test-only service. Retained so `@moflo/embeddings` has a stable
 * in-process fake for unit tests, but NOT reachable from the factory — the
 * production path is neural-only.
 */
export class MockEmbeddingService extends BaseEmbeddingService {
  readonly provider: EmbeddingProvider = 'mock';
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
    super(fullConfig);
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

    const embedding = this.deterministicEmbedding(text);
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
        const embedding = this.deterministicEmbedding(text);
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

  private deterministicEmbedding(text: string): Float32Array {
    const embedding = new Float32Array(this.dimensions);

    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash = hash & hash;
    }

    for (let i = 0; i < this.dimensions; i++) {
      const seed = hash + i * 2654435761;
      const x = Math.sin(seed) * 10000;
      embedding[i] = x - Math.floor(x);
    }

    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    for (let i = 0; i < this.dimensions; i++) {
      embedding[i] /= norm;
    }

    return embedding;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

// Lazy-resolved at call time so tests can mock the module via vi.mock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadFastembedService(): Promise<any> {
  const mod = await import('./fastembed-embedding-service.js');
  return mod.FastembedEmbeddingService;
}

/**
 * Construct an embedding service from a configuration.
 *
 * Synchronous factory. For providers that require initialization (fastembed
 * model load), that work is performed lazily inside the service. If model
 * loading fails at first-use time, the service throws — there is no hash
 * fallback.
 *
 * `'mock'` is accepted only for test contexts; production callers should not
 * pass it. The `'transformers'` key is a backwards-compatible alias for
 * `'fastembed'` so existing callers keep working without config changes.
 */
export function createEmbeddingService(config: EmbeddingConfig): IEmbeddingService {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingService(config as OpenAIEmbeddingConfig);
    case 'fastembed':
    case 'transformers': {
      // Synchronous construction — the async model load happens on first embed().
      // Lazy-requiring keeps the fastembed module out of the call stack when it
      // isn't needed (e.g. mock-only tests).
      // eslint-disable-next-line @typescript-eslint/no-require-imports,@typescript-eslint/no-var-requires
      return lazyFastembed(config as FastembedEmbeddingConfig | TransformersEmbeddingConfig);
    }
    case 'mock':
      return new MockEmbeddingService(config as MockEmbeddingConfig);
    default: {
      const provider: string = (config as { provider?: string }).provider ?? '<none>';
      throw new Error(
        `Unknown embedding provider: '${provider}'. Supported: 'openai', 'fastembed', 'transformers', 'mock'.`,
      );
    }
  }
}

/**
 * Build a fastembed-backed service whose init is deferred until first embed().
 * Keeps `createEmbeddingService` synchronous while still sharing the real
 * FastembedEmbeddingService implementation.
 */
function lazyFastembed(
  config: FastembedEmbeddingConfig | TransformersEmbeddingConfig,
): IEmbeddingService {
  const fastembedConfig: FastembedEmbeddingConfig = {
    provider: 'fastembed',
    dimensions: config.dimensions,
    cacheSize: config.cacheSize,
    enableCache: config.enableCache,
    normalization: config.normalization,
    persistentCache: config.persistentCache,
    model: 'model' in config ? (config.model as string | undefined) : undefined,
  };

  return new LazyFastembedService(fastembedConfig);
}

/**
 * Wrapper that defers loading the fastembed-backed service implementation
 * until the first embed call. Keeps `createEmbeddingService` synchronous.
 */
class LazyFastembedService implements IEmbeddingService {
  readonly provider: EmbeddingProvider;
  private inner: IEmbeddingService | null = null;
  private loadPromise: Promise<IEmbeddingService> | null = null;

  constructor(private readonly config: FastembedEmbeddingConfig) {
    this.provider = config.provider ?? 'fastembed';
  }

  private async ensure(): Promise<IEmbeddingService> {
    if (this.inner) return this.inner;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const Service = await loadFastembedService();
        this.inner = new Service(this.config) as IEmbeddingService;
        return this.inner;
      })();
    }
    return this.loadPromise;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const svc = await this.ensure();
    return svc.embed(text);
  }

  async embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    const svc = await this.ensure();
    return svc.embedBatch(texts);
  }

  clearCache(): void {
    this.inner?.clearCache();
  }

  getCacheStats() {
    return this.inner?.getCacheStats() ?? { size: 0, maxSize: 0, hitRate: 0 };
  }

  async shutdown(): Promise<void> {
    if (this.inner) {
      await this.inner.shutdown();
      this.inner = null;
    }
    this.loadPromise = null;
  }
}

/**
 * Extended config with explicit provider selection.
 *
 * Unlike the previous `'auto'` behaviour, there is no silent fallback chain —
 * the chosen provider either initializes or throws.
 */
export interface AutoEmbeddingConfig {
  /** Provider: neural only — 'fastembed', 'transformers' (alias), 'openai'. 'mock' is test-only. */
  provider: EmbeddingProvider;
  /** Model name (fastembed/transformers) */
  model?: string;
  /** Model ID override (legacy parameter kept for call-site compatibility) */
  modelId?: string;
  /** Embedding dimensions */
  dimensions?: number;
  /** Cache size */
  cacheSize?: number;
  /** OpenAI API key (required for openai provider) */
  apiKey?: string;
}

/**
 * Async factory — constructs a service and validates it can embed.
 *
 * Unlike the old `'auto'` behaviour, this never silently falls back to another
 * provider. Validation happens eagerly so callers learn about a broken model
 * download (etc.) at startup rather than at first query.
 */
export async function createEmbeddingServiceAsync(
  config: AutoEmbeddingConfig,
): Promise<IEmbeddingService> {
  const { provider, ...rest } = config;

  const service = createEmbeddingService(buildConfig(provider, rest));

  // Prove the service works (loads fastembed model, hits OpenAI, etc.).
  // A failure here is a hard error — no hash fallback.
  await service.embed('test');
  return service;
}

function buildConfig(
  provider: EmbeddingProvider,
  rest: Omit<AutoEmbeddingConfig, 'provider'>,
): EmbeddingConfig {
  switch (provider) {
    case 'openai':
      if (!rest.apiKey) throw new Error('OpenAI provider requires apiKey');
      return {
        provider: 'openai',
        apiKey: rest.apiKey,
        dimensions: rest.dimensions,
        cacheSize: rest.cacheSize,
      };
    case 'fastembed':
    case 'transformers':
      return {
        provider,
        model: rest.model,
        dimensions: rest.dimensions,
        cacheSize: rest.cacheSize,
      } as FastembedEmbeddingConfig | TransformersEmbeddingConfig;
    case 'mock':
      return {
        provider: 'mock',
        dimensions: rest.dimensions ?? 384,
        cacheSize: rest.cacheSize,
      };
    default:
      throw new Error(`Unknown embedding provider: '${provider as string}'`);
  }
}

/**
 * Convenience — embed a single string. Test-only; production callers should
 * construct a long-lived service and reuse it.
 */
export async function getEmbedding(
  text: string,
  config?: Partial<EmbeddingConfig>,
): Promise<Float32Array | number[]> {
  const service = createEmbeddingService({
    provider: 'mock',
    dimensions: 384,
    ...config,
  } as EmbeddingConfig);

  try {
    const result = await service.embed(text);
    return result.embedding;
  } finally {
    await service.shutdown();
  }
}

// ============================================================================
// Similarity Functions
// ============================================================================

export function cosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  if (a.length !== b.length) {
    throw new Error('Embedding dimensions must match');
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export function euclideanDistance(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  if (a.length !== b.length) {
    throw new Error('Embedding dimensions must match');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

export function dotProduct(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  if (a.length !== b.length) {
    throw new Error('Embedding dimensions must match');
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }

  return dot;
}

export function computeSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[],
  metric: SimilarityMetric = 'cosine',
): SimilarityResult {
  switch (metric) {
    case 'cosine':
      return { score: cosineSimilarity(a, b), metric };
    case 'euclidean':
      return { score: euclideanDistance(a, b), metric };
    case 'dot':
      return { score: dotProduct(a, b), metric };
    default:
      return { score: cosineSimilarity(a, b), metric: 'cosine' };
  }
}
