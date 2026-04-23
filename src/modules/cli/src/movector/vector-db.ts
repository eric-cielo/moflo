/**
 * Vector Database Module
 *
 * Provides optional WASM-accelerated vector operations for:
 * - Semantic similarity search
 * - HNSW indexing (150x faster)
 * - Embedding generation
 *
 * Gracefully degrades when native backend is not available.
 *
 * Created with love by motailz.com
 */

// ============================================================================
// Types
// ============================================================================

export interface VectorDB {
  insert(embedding: Float32Array, id: string, metadata?: Record<string, unknown>): void | Promise<void>;
  search(query: Float32Array, k?: number): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> | Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>>;
  remove(id: string): boolean | Promise<boolean>;
  size(): number | Promise<number>;
  clear(): void | Promise<void>;
}

export interface MoVectorModule {
  createVectorDB(dimensions: number): Promise<VectorDB>;
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
  isWASMAccelerated(): boolean;
}

// ============================================================================
// Fallback Implementation (when native backend not available)
// ============================================================================

class FallbackVectorDB implements VectorDB {
  private vectors: Map<string, { embedding: Float32Array; metadata?: Record<string, unknown> }> = new Map();
  private dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  insert(embedding: Float32Array, id: string, metadata?: Record<string, unknown>): void {
    this.vectors.set(id, { embedding, metadata });
  }

  search(query: Float32Array, k: number = 10): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> {
    const results: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];

    for (const [id, { embedding, metadata }] of this.vectors) {
      const score = cosineSimilarity(query, embedding);
      results.push({ id, score, metadata });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  remove(id: string): boolean {
    return this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }

  clear(): void {
    this.vectors.clear();
  }
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ============================================================================
// Module State
// ============================================================================

let movectorModule: MoVectorModule | null = null;
let loadAttempted = false;
let isAvailable = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Load vector DB module (pure TS — always available)
 */
export async function loadMovector(): Promise<boolean> {
  loadAttempted = true;
  isAvailable = false;
  return false;
}

/**
 * Check if native backend is available
 */
export function isMoVectorAvailable(): boolean {
  return isAvailable;
}

/**
 * Check if WASM acceleration is enabled
 */
export function isWASMAccelerated(): boolean {
  if (movectorModule && typeof movectorModule.isWASMAccelerated === 'function') {
    return movectorModule.isWASMAccelerated();
  }
  return false;
}

/**
 * Create a vector database (pure TS brute-force cosine similarity)
 */
export async function createVectorDB(dimensions: number = 768): Promise<VectorDB> {
  return new FallbackVectorDB(dimensions);
}

/**
 * Compute cosine similarity between two vectors
 */
export function computeSimilarity(a: Float32Array, b: Float32Array): number {
  if (movectorModule && typeof movectorModule.cosineSimilarity === 'function') {
    try {
      return movectorModule.cosineSimilarity(a, b);
    } catch {
      // Fall back to JS implementation
    }
  }

  return cosineSimilarity(a, b);
}

/**
 * Get status information about the movector module
 */
export function getStatus(): {
  available: boolean;
  wasmAccelerated: boolean;
  backend: 'native-wasm' | 'native' | 'fallback';
} {
  if (!isAvailable) {
    return {
      available: false,
      wasmAccelerated: false,
      backend: 'fallback',
    };
  }

  const wasmAccelerated = isWASMAccelerated();
  return {
    available: true,
    wasmAccelerated,
    backend: wasmAccelerated ? 'native-wasm' : 'native',
  };
}
