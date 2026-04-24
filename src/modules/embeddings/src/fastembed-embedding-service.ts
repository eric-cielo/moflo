/**
 * Fastembed Embedding Service
 *
 * Wraps Qdrant's `fastembed` npm package — ONNX-based neural embeddings with a
 * native Rust tokenizer (via @anush008/tokenizers). Default model is
 * `all-MiniLM-L6-v2` producing 384-dim `Float32Array` vectors, matching the
 * shape of `TransformersEmbeddingService` so callers can swap without changes.
 *
 * Lazy init — the `fastembed` module and ONNX session are loaded on first
 * `embed()`/`embedBatch()` call.
 *
 * @module @moflo/embeddings
 */

import type {
  EmbeddingProvider,
  EmbeddingResult,
  BatchEmbeddingResult,
  FastembedEmbeddingConfig,
} from './types.js';
import { BaseEmbeddingService } from './embedding-service.js';

const DEFAULT_BATCH_SIZE = 32;

export type FastembedModel = {
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  queryEmbed(query: string): Promise<number[]>;
};

export type FastembedModule = {
  EmbeddingModel: Record<string, string>;
  FlagEmbedding: {
    init(options: {
      model: string;
      cacheDir?: string;
      maxLength?: number;
      showDownloadProgress?: boolean;
    }): Promise<FastembedModel>;
  };
};

/**
 * Optional dependency injection for the `fastembed` module — tests pass a mock
 * loader here; production callers omit `deps` and get the real `import('fastembed')`.
 */
export interface FastembedServiceDeps {
  loadModule?: () => Promise<FastembedModule>;
}

const defaultLoader = async (): Promise<FastembedModule> =>
  (await import('fastembed')) as unknown as FastembedModule;

export class FastembedEmbeddingService extends BaseEmbeddingService {
  readonly provider: EmbeddingProvider = 'fastembed';

  private model: FastembedModel | null = null;
  private initPromise: Promise<FastembedModel> | null = null;
  private readonly modelName: string | undefined;
  private readonly cacheDir: string | undefined;
  private readonly maxLength: number | undefined;
  private readonly showDownloadProgress: boolean;
  private readonly batchSize: number;
  private readonly loadModule: () => Promise<FastembedModule>;

  constructor(config: FastembedEmbeddingConfig, deps: FastembedServiceDeps = {}) {
    super(config);
    this.modelName = config.model;
    this.cacheDir = config.cacheDir;
    this.maxLength = config.maxLength;
    this.showDownloadProgress = config.showDownloadProgress ?? false;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.loadModule = deps.loadModule ?? defaultLoader;
  }

  private async initialize(): Promise<FastembedModel> {
    if (this.model) return this.model;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const mod = await this.loadModule();
        const modelName = this.modelName ?? mod.EmbeddingModel.AllMiniLML6V2;
        const initOptions: {
          model: string;
          cacheDir?: string;
          maxLength?: number;
          showDownloadProgress?: boolean;
        } = {
          model: modelName,
          showDownloadProgress: this.showDownloadProgress,
        };
        // Resolution order: explicit config > FASTEMBED_CACHE env > fastembed default.
        const cacheDir = this.cacheDir ?? process.env.FASTEMBED_CACHE;
        if (cacheDir) initOptions.cacheDir = cacheDir;
        if (this.maxLength !== undefined) initOptions.maxLength = this.maxLength;
        const model = await mod.FlagEmbedding.init(initOptions);
        this.model = model;
        return model;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to initialize fastembed: ${message}`);
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const cached = this.cache.get(text);
    if (cached) {
      this.emitEvent({ type: 'cache_hit', text });
      return {
        embedding: cached,
        latencyMs: 0,
        cached: true,
      };
    }

    const model = await this.initialize();

    this.emitEvent({ type: 'embed_start', text });
    const startTime = performance.now();

    try {
      const vector = await model.queryEmbed(text);
      const embedding = new Float32Array(vector);
      this.cache.set(text, embedding);

      const latencyMs = performance.now() - startTime;
      this.emitEvent({ type: 'embed_complete', text, latencyMs });

      return {
        embedding,
        latencyMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: 'embed_error', text, error: message });
      throw new Error(`Fastembed embedding failed: ${message}`);
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

    let freshEmbeddings: Float32Array[] = [];
    if (uncached.length > 0) {
      const model = await this.initialize();
      const uncachedTexts = uncached.map(u => u.text);

      try {
        for await (const batch of model.embed(uncachedTexts, this.batchSize)) {
          for (const vector of batch) {
            freshEmbeddings.push(new Float32Array(vector));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Fastembed batch embedding failed: ${message}`);
      }

      if (freshEmbeddings.length !== uncached.length) {
        throw new Error(
          `Fastembed returned ${freshEmbeddings.length} embeddings for ${uncached.length} texts`,
        );
      }

      uncached.forEach((item, i) => {
        this.cache.set(item.text, freshEmbeddings[i]);
      });
    }

    const embeddings: Float32Array[] = new Array(texts.length);
    cached.forEach(c => {
      embeddings[c.index] = c.embedding;
    });
    uncached.forEach((u, i) => {
      embeddings[u.index] = freshEmbeddings[i];
    });

    const totalLatencyMs = performance.now() - startTime;
    this.emitEvent({ type: 'batch_complete', count: texts.length, latencyMs: totalLatencyMs });

    return {
      embeddings,
      totalLatencyMs,
      avgLatencyMs: texts.length > 0 ? totalLatencyMs / texts.length : 0,
      cacheStats: {
        hits: cached.length,
        misses: uncached.length,
      },
    };
  }

  override async shutdown(): Promise<void> {
    this.model = null;
    this.initPromise = null;
    await super.shutdown();
  }
}
