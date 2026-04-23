import { describe, it, expect } from 'vitest';
import {
  cosine,
  deserializeEmbedding,
  embedText,
  rankByVector,
  serializeEmbedding,
} from './_shared.js';
import { deterministicTestEmbedder } from './_test-embedder.js';

describe('_shared vector helpers', () => {
  it('cosine of identical vectors is 1', () => {
    const v = Float32Array.from([0.3, 0.4, 0.5]);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it('cosine of zero vector is 0', () => {
    const zero = new Float32Array(4);
    const v = Float32Array.from([1, 0, 0, 0]);
    expect(cosine(zero, v)).toBe(0);
  });

  it('serialize/deserialize round-trips embeddings', () => {
    const v = Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8]);
    const blob = serializeEmbedding(v);
    expect(blob).toBeInstanceOf(Uint8Array);
    const restored = deserializeEmbedding(blob);
    expect(restored).not.toBeNull();
    expect(Array.from(restored!)).toEqual(Array.from(v));
  });

  it('deserialize rejects malformed blobs', () => {
    expect(deserializeEmbedding(null)).toBeNull();
    expect(deserializeEmbedding('not a blob' as unknown)).toBeNull();
    expect(deserializeEmbedding(new Uint8Array(3))).toBeNull(); // not mult of 4
  });

  it('embedText uses the supplied embedder', async () => {
    const v = await embedText(deterministicTestEmbedder, 'alpha beta');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
    // Token-bag: two unique tokens light up exactly two slots.
    const ones = Array.from(v).filter((x) => x === 1).length;
    expect(ones).toBe(2);
  });

  it('embedText throws when no embedder is configured', async () => {
    await expect(embedText(undefined, 'anything')).rejects.toThrow(/ADR-EMB-001/);
  });

  it('embedText propagates embedder failures (no silent fallback)', async () => {
    const boom = async () => {
      throw new Error('fastembed model missing');
    };
    await expect(embedText(boom, 'x')).rejects.toThrow(/fastembed model missing/);
  });

  it('rankByVector sorts by cosine and honours k', () => {
    const q = Float32Array.from([1, 0, 0]);
    const rows = [
      { id: 'x', embedding: Float32Array.from([1, 0, 0]), content: 'x' },
      { id: 'y', embedding: Float32Array.from([0, 1, 0]), content: 'y' },
      { id: 'z', embedding: Float32Array.from([0.9, 0.1, 0]), content: 'z' },
    ];
    const out = rankByVector(rows, q, 'x', 2);
    expect(out.length).toBe(2);
    expect(out[0].id).toBe('x');
    expect(out[1].id).toBe('z');
  });

  it('rankByVector falls back to keyword overlap when embedding missing', () => {
    const q = Float32Array.from([1, 0, 0]);
    const rows = [
      { id: 'a', embedding: null, content: 'needle in the haystack' },
      { id: 'b', embedding: null, content: 'unrelated words' },
    ];
    const out = rankByVector(rows, q, 'needle', 2);
    expect(out[0].id).toBe('a');
  });
});
