/**
 * Happy-path smoke tests for embeddings core modules:
 * - chunking.ts
 * - normalization.ts
 * - hyperbolic.ts
 */

import { describe, it, expect } from 'vitest';

// ── Chunking ─────────────────────────────────────────────────────────────────

import {
  chunkText,
  estimateTokens,
  reconstructFromChunks,
  type ChunkedDocument,
} from '../src/chunking.js';

describe('chunking', () => {
  it('chunkText splits text into at least one chunk', () => {
    const doc: ChunkedDocument = chunkText('Hello world. This is a test.');
    expect(doc.chunks.length).toBeGreaterThanOrEqual(1);
    expect(doc.totalChunks).toBe(doc.chunks.length);
    expect(doc.originalLength).toBe('Hello world. This is a test.'.length);
  });

  it('chunkText produces multiple chunks for long text', () => {
    const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
    const doc = chunkText(longText, { maxChunkSize: 200, minChunkSize: 50 });
    expect(doc.chunks.length).toBeGreaterThan(1);
  });

  it('each chunk has required metadata fields', () => {
    const doc = chunkText('Some text that should be chunked properly.');
    for (const chunk of doc.chunks) {
      expect(chunk).toHaveProperty('text');
      expect(chunk).toHaveProperty('index');
      expect(chunk).toHaveProperty('startPos');
      expect(chunk).toHaveProperty('endPos');
      expect(chunk).toHaveProperty('length');
      expect(chunk).toHaveProperty('tokenCount');
    }
  });

  it('estimateTokens returns a positive number for non-empty text', () => {
    expect(estimateTokens('Hello world')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
  });

  it('reconstructFromChunks returns a string', () => {
    const doc = chunkText('Short text.');
    const result = reconstructFromChunks(doc.chunks);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('character strategy works', () => {
    const doc = chunkText('abcdefghij', { strategy: 'character', maxChunkSize: 5, overlap: 1, minChunkSize: 1 });
    expect(doc.chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Normalization ────────────────────────────────────────────────────────────

import {
  l2Normalize,
  l1Normalize,
  minMaxNormalize,
  zScoreNormalize,
  normalize,
  normalizeBatch,
  l2Norm,
  isNormalized,
  centerEmbeddings,
} from '../src/normalization.js';

describe('normalization', () => {
  const vec = new Float32Array([3, 4]);

  it('l2Normalize produces a unit vector', () => {
    const result = l2Normalize(vec);
    const norm = Math.sqrt(result[0] ** 2 + result[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('l2Normalize works with number[] input', () => {
    const result = l2Normalize([3, 4]);
    expect(result).toBeInstanceOf(Float32Array);
    const norm = Math.sqrt(result[0] ** 2 + result[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('l1Normalize sums absolute values to 1', () => {
    const result = l1Normalize(vec);
    let sum = 0;
    for (let i = 0; i < result.length; i++) sum += Math.abs(result[i]);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('minMaxNormalize maps to [0, 1]', () => {
    const result = minMaxNormalize(new Float32Array([1, 5, 3]));
    expect(result[0]).toBeCloseTo(0, 5); // min
    expect(result[1]).toBeCloseTo(1, 5); // max
  });

  it('zScoreNormalize produces mean near 0', () => {
    const result = zScoreNormalize(new Float32Array([1, 2, 3, 4, 5]));
    let sum = 0;
    for (let i = 0; i < result.length; i++) sum += result[i];
    expect(sum / result.length).toBeCloseTo(0, 4);
  });

  it('normalize dispatches to correct method', () => {
    const l2 = normalize(vec, { type: 'l2' });
    expect(isNormalized(l2)).toBe(true);

    const none = normalize(vec, { type: 'none' });
    expect(none[0]).toBeCloseTo(3, 5);
  });

  it('normalizeBatch processes multiple vectors', () => {
    const batch = normalizeBatch([vec, new Float32Array([1, 0])]);
    expect(batch).toHaveLength(2);
    expect(isNormalized(batch[0])).toBe(true);
    expect(isNormalized(batch[1])).toBe(true);
  });

  it('l2Norm returns correct magnitude', () => {
    expect(l2Norm(vec)).toBeCloseTo(5, 5);
  });

  it('isNormalized detects unit vectors', () => {
    expect(isNormalized(l2Normalize(vec))).toBe(true);
    expect(isNormalized(vec)).toBe(false);
  });

  it('centerEmbeddings returns centered vectors', () => {
    const result = centerEmbeddings([
      new Float32Array([1, 0]),
      new Float32Array([3, 0]),
    ]);
    expect(result).toHaveLength(2);
    // mean was [2, 0], so centered: [-1, 0] and [1, 0]
    expect(result[0][0]).toBeCloseTo(-1, 5);
    expect(result[1][0]).toBeCloseTo(1, 5);
  });
});

// ── Hyperbolic ───────────────────────────────────────────────────────────────

import {
  euclideanToPoincare,
  poincareToEuclidean,
  hyperbolicDistance,
  mobiusAdd,
  mobiusScalarMul,
  hyperbolicCentroid,
  batchEuclideanToPoincare,
  isInPoincareBall,
} from '../src/hyperbolic.js';

describe('hyperbolic', () => {
  const vecA = new Float32Array([0.1, 0.2]);
  const vecB = new Float32Array([0.3, 0.1]);

  it('euclideanToPoincare returns a Float32Array inside the ball', () => {
    const result = euclideanToPoincare(new Float32Array([1, 2, 3]));
    expect(result).toBeInstanceOf(Float32Array);
    expect(isInPoincareBall(result)).toBe(true);
  });

  it('poincareToEuclidean inverts euclideanToPoincare approximately', () => {
    const original = new Float32Array([0.5, 0.3]);
    const poincare = euclideanToPoincare(original);
    const back = poincareToEuclidean(poincare);
    expect(back[0]).toBeCloseTo(original[0], 1);
    expect(back[1]).toBeCloseTo(original[1], 1);
  });

  it('hyperbolicDistance returns a non-negative number', () => {
    const d = hyperbolicDistance(vecA, vecB);
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it('hyperbolicDistance is zero for identical points', () => {
    const d = hyperbolicDistance(vecA, vecA);
    expect(d).toBeCloseTo(0, 5);
  });

  it('hyperbolicDistance throws for mismatched dimensions', () => {
    expect(() => hyperbolicDistance(
      new Float32Array([0.1]),
      new Float32Array([0.1, 0.2]),
    )).toThrow('same dimension');
  });

  it('mobiusAdd does not throw for valid inputs', () => {
    const result = mobiusAdd(vecA, vecB);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(2);
  });

  it('mobiusScalarMul does not throw', () => {
    const result = mobiusScalarMul(2, vecA);
    expect(result).toBeInstanceOf(Float32Array);
    expect(isInPoincareBall(result)).toBe(true);
  });

  it('hyperbolicCentroid returns a point inside the ball', () => {
    const centroid = hyperbolicCentroid([vecA, vecB]);
    expect(centroid).toBeInstanceOf(Float32Array);
    expect(isInPoincareBall(centroid)).toBe(true);
  });

  it('batchEuclideanToPoincare converts all vectors', () => {
    const batch = batchEuclideanToPoincare([vecA, vecB]);
    expect(batch).toHaveLength(2);
    for (const p of batch) {
      expect(isInPoincareBall(p)).toBe(true);
    }
  });

  it('isInPoincareBall returns true for small vectors', () => {
    expect(isInPoincareBall(new Float32Array([0, 0, 0]))).toBe(true);
    expect(isInPoincareBall(new Float32Array([0.1, 0.1]))).toBe(true);
  });
});
