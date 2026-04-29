/**
 * Round-trip + format-validation tests for HnswLite serialize/load (#734).
 *
 * The graph (vectors + neighbor adjacency) round-trips byte-for-byte and
 * search results must be identical before and after a serialize→load cycle.
 * Negative tests assert the format gates (magic, version, size) so corrupted
 * sidecars surface a clear error rather than silently degrading.
 */
import { describe, it, expect } from 'vitest';
import { HnswLite } from '../../memory/hnsw-lite.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function buildIndex(rows: number, dim: number, seed = 1): HnswLite {
  const rand = rng(seed);
  const idx = new HnswLite(dim, 16, 200, 'cosine');
  for (let i = 0; i < rows; i++) {
    const v = new Float32Array(dim);
    for (let j = 0; j < dim; j++) v[j] = rand() * 2 - 1;
    idx.add(`row-${i.toString().padStart(4, '0')}-uuid-${seed}`, v);
  }
  return idx;
}

describe('HnswLite serialize / load', () => {
  it('round-trips a small index exactly (size + neighbors + vectors)', () => {
    const original = buildIndex(50, 32);
    const buf = original.serialize();
    const loaded = HnswLite.load(buf);

    expect(loaded.size).toBe(original.size);

    // Same search results for 10 random queries.
    const rand = rng(99);
    for (let q = 0; q < 10; q++) {
      const query = new Float32Array(32);
      for (let j = 0; j < 32; j++) query[j] = rand() * 2 - 1;
      const a = original.search(query, 5);
      const b = loaded.search(query, 5);
      expect(b.map(r => r.id)).toEqual(a.map(r => r.id));
      for (let i = 0; i < a.length; i++) {
        expect(b[i].score).toBeCloseTo(a[i].score, 6);
      }
    }
  });

  it('round-trips at realistic dim=384 with 200 vectors', () => {
    const original = buildIndex(200, 384, 7);
    const loaded = HnswLite.load(original.serialize());

    const rand = rng(123);
    for (let q = 0; q < 20; q++) {
      const query = new Float32Array(384);
      for (let j = 0; j < 384; j++) query[j] = rand() * 2 - 1;
      const a = original.search(query, 8);
      const b = loaded.search(query, 8);
      expect(b.map(r => r.id)).toEqual(a.map(r => r.id));
    }
  });

  it('round-trips an empty index', () => {
    const empty = new HnswLite(384, 16, 200, 'cosine');
    const loaded = HnswLite.load(empty.serialize());
    expect(loaded.size).toBe(0);
    expect(loaded.search(new Float32Array(384), 5)).toEqual([]);
  });

  it('preserves the configured metric across a round-trip', () => {
    const dot = new HnswLite(8, 4, 50, 'dot');
    dot.add('a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    dot.add('b', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));
    const loaded = HnswLite.load(dot.serialize());
    // Dot of [1,0,...] with itself is 1; with [0,1,...] is 0.
    const r = loaded.search(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 2);
    expect(r[0].id).toBe('a');
    expect(r[0].score).toBeCloseTo(1, 6);
    expect(r[1].score).toBeCloseTo(0, 6);
  });

  it('rejects a buffer with wrong magic', () => {
    const bad = Buffer.alloc(64);
    bad.write('NOTMAGIC', 0, 'ascii');
    expect(() => HnswLite.load(bad)).toThrow(/bad magic/);
  });

  it('rejects a buffer smaller than the header', () => {
    expect(() => HnswLite.load(Buffer.alloc(8))).toThrow(/too small/);
  });

  it('rejects an unknown version', () => {
    const buf = buildIndex(3, 8).serialize();
    buf.writeUInt8(99, 8);
    expect(() => HnswLite.load(buf)).toThrow(/unsupported version/);
  });

  it('rejects a truncated buffer', () => {
    const buf = buildIndex(3, 8).serialize();
    expect(() => HnswLite.load(buf.subarray(0, buf.length - 4))).toThrow(/size mismatch/);
  });

  it('rejects a JSON section that does not match vectorCount', () => {
    const idx = buildIndex(3, 8);
    const buf = idx.serialize();
    // Rewrite vectorCount (offset 24) to 2 — header now says 2 but JSON has 3.
    buf.writeUInt32LE(2, 24);
    expect(() => HnswLite.load(buf)).toThrow(/size mismatch|arity mismatch/);
  });
});
