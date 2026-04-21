import { describe, it, expect } from 'vitest';
import {
  cosine,
  deserializeEmbedding,
  embedWithFallback,
  hashEmbed,
  rankByVector,
  serializeEmbedding,
} from './_shared.js';

describe('_shared vector helpers', () => {
  it('hashEmbed produces a unit-normalized vector', () => {
    const v = hashEmbed('hello world', 64);
    expect(v.length).toBe(64);
    let mag = 0;
    for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
    expect(Math.sqrt(mag)).toBeCloseTo(1, 4);
  });

  it('hashEmbed returns zero vector for empty input', () => {
    const v = hashEmbed('', 16);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('hashEmbed is deterministic', () => {
    const a = hashEmbed('stable tokens', 32);
    const b = hashEmbed('stable tokens', 32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('cosine of identical vectors is 1', () => {
    const v = hashEmbed('abc', 16);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it('cosine of zero vector is 0', () => {
    const zero = new Float32Array(8);
    const v = hashEmbed('abc', 8);
    expect(cosine(zero, v)).toBe(0);
  });

  it('serialize/deserialize round-trips embeddings', () => {
    const v = hashEmbed('payload', 32);
    const blob = serializeEmbedding(v);
    expect(blob).toBeInstanceOf(Uint8Array);
    const restored = deserializeEmbedding(blob);
    expect(restored).not.toBeNull();
    expect(Array.from(restored!)).toEqual(Array.from(v));
  });

  it('deserialize rejects malformed blobs', () => {
    expect(deserializeEmbedding(null)).toBeNull();
    expect(deserializeEmbedding('not a blob' as any)).toBeNull();
    expect(deserializeEmbedding(new Uint8Array(3))).toBeNull(); // not mult of 4
  });

  it('embedWithFallback uses embedder when provided, else hashEmbed', async () => {
    const custom = async () => Float32Array.from([1, 0, 0, 0]);
    const a = await embedWithFallback(custom, 'ignored', 4);
    expect(Array.from(a)).toEqual([1, 0, 0, 0]);
    const b = await embedWithFallback(undefined, 'anything', 4);
    expect(b.length).toBe(4);
  });

  it('embedWithFallback falls back when embedder throws', async () => {
    const bad = async () => { throw new Error('no embedder'); };
    const v = await embedWithFallback(bad, 'fallback', 8);
    expect(v.length).toBe(8);
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
