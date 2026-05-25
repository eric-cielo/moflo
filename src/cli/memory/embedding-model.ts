/**
 * Neural embedding model manager.
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition). Lazily loads
 * the fastembed-backed embedding service (ONNX all-MiniLM-L6-v2) and generates
 * embeddings. There is NO hash fallback — a failed model load throws (hash
 * embeddings were removed in epic #527).
 *
 * @module memory/embedding-model
 */

import { formatEmbeddingError } from './embedding-errors.js';
import { getBridge } from './bridge-loader.js';

/**
 * Neural embedding model manager.
 *
 * Lazily loads the fastembed-backed service from cli's embeddings module. The
 * service itself defers the ONNX model download until the first embed call,
 * so `loadEmbeddingModel` is cheap until embeddings are actually needed.
 *
 * There is no hash fallback: a failed model load throws.
 */
interface EmbeddingModel {
  loaded: boolean;
  service: {
    embed(text: string): Promise<{ embedding: Float32Array | number[] }>;
  } | null;
  dimensions: number;
  modelName: string;
}

let embeddingModelState: EmbeddingModel | null = null;

/**
 * Lazy-load the neural embedding service.
 *
 * Delegates to the local fastembed-backed service. Returns a diagnostic
 * result for callers that want to report status; if model loading fails later
 * on first `embed()`, that throws from `generateEmbedding`.
 */
export async function loadEmbeddingModel(options?: {
  modelPath?: string;
  verbose?: boolean;
}): Promise<{
  success: boolean;
  dimensions: number;
  modelName: string;
  loadTime?: number;
  error?: string;
}> {
  const { verbose = false } = options || {};
  const startTime = Date.now();

  if (embeddingModelState?.loaded) {
    return {
      success: true,
      dimensions: embeddingModelState.dimensions,
      modelName: 'cached',
      loadTime: 0,
    };
  }

  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeLoadEmbeddingModel();
    if (bridgeResult && bridgeResult.success) {
      embeddingModelState = {
        loaded: true,
        service: null, // Bridge handles embedding
        dimensions: bridgeResult.dimensions,
        modelName: bridgeResult.modelName || 'bridge',
      };
      return bridgeResult;
    }
  }

  if (verbose) {
    console.log('Preparing neural embedding runtime (fastembed / all-MiniLM-L6-v2)...');
  }

  const { createEmbeddingService } = await import('../embeddings/embedding-service.js');
  const service = createEmbeddingService({
    provider: 'fastembed',
    dimensions: 384,
  });

  embeddingModelState = {
    loaded: true,
    service,
    dimensions: 384,
    modelName: 'fastembed/all-MiniLM-L6-v2',
  };

  return {
    success: true,
    dimensions: 384,
    modelName: 'fastembed/all-MiniLM-L6-v2',
    loadTime: Date.now() - startTime,
  };
}

/**
 * Generate a neural embedding for text.
 *
 * Uses the fastembed-backed service from cli's embeddings module. Throws on model
 * load / inference failure — there is no hash fallback.
 */
export async function generateEmbedding(text: string): Promise<{
  embedding: number[];
  dimensions: number;
  model: string;
}> {
  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeGenerateEmbedding(text);
    if (bridgeResult) return bridgeResult;
  }

  if (!embeddingModelState?.loaded) {
    const load = await loadEmbeddingModel();
    if (!load.success) {
      throw new Error(formatEmbeddingError(load.error ?? 'unknown error'));
    }
  }

  const state = embeddingModelState!;

  if (!state.service) {
    throw new Error(
      `Embedding model state has no active service. Bridge-backed state requires ` +
        `bridge.bridgeGenerateEmbedding(); hash fallback was removed in epic #527.`,
    );
  }

  let result: { embedding: Float32Array | number[] };
  try {
    result = await state.service.embed(text);
  } catch (err) {
    throw new Error(formatEmbeddingError(err));
  }
  const embedding = Array.from(result.embedding as Float32Array | number[]);
  return {
    embedding,
    dimensions: embedding.length,
    model: state.modelName,
  };
}

/**
 * Generate embeddings for multiple texts
 * Uses parallel execution for API-based providers (2-4x faster)
 * Note: Local ONNX inference is CPU-bound, so parallelism has limited benefit
 *
 * @param texts - Array of texts to embed
 * @param options - Batch options
 * @returns Array of embedding results with timing info
 */
export async function generateBatchEmbeddings(
  texts: string[],
  options?: {
    concurrency?: number; // Max concurrent embeddings (default: all)
    onProgress?: (completed: number, total: number) => void;
  }
): Promise<{
  results: Array<{ text: string; embedding: number[]; dimensions: number; model: string }>;
  totalTime: number;
  avgTime: number;
}> {
  const { concurrency = texts.length, onProgress } = options || {};
  const startTime = Date.now();

  // Ensure model is loaded first (prevents cold start in parallel)
  if (!embeddingModelState?.loaded) {
    await loadEmbeddingModel();
  }

  // Process in parallel with optional concurrency limit
  if (concurrency >= texts.length) {
    // Full parallelism
    const embeddings = await Promise.all(
      texts.map(async (text, i) => {
        const result = await generateEmbedding(text);
        onProgress?.(i + 1, texts.length);
        return { text, ...result };
      })
    );

    const totalTime = Date.now() - startTime;
    return {
      results: embeddings,
      totalTime,
      avgTime: totalTime / texts.length
    };
  }

  // Limited concurrency using chunking
  const results: Array<{ text: string; embedding: number[]; dimensions: number; model: string }> = [];
  let completed = 0;

  for (let i = 0; i < texts.length; i += concurrency) {
    const chunk = texts.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (text) => {
        const result = await generateEmbedding(text);
        completed++;
        onProgress?.(completed, texts.length);
        return { text, ...result };
      })
    );
    results.push(...chunkResults);
  }

  const totalTime = Date.now() - startTime;
  return {
    results,
    totalTime,
    avgTime: totalTime / texts.length
  };
}
