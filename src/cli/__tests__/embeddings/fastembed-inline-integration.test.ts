/**
 * Integration test for the in-tree fastembed replacement — exercises the full
 * download → tokenize → ONNX inference → CLS-pool → L2-normalize pipeline
 * against the real `all-MiniLM-L6-v2` model.
 *
 * Caching: relies on `FASTEMBED_CACHE` (or the default `~/.cache/fastembed`).
 * CI pre-caches the model in the consumer-install-smoke workflow; locally the
 * first run downloads ~25 MB. Subsequent runs are network-free and fast.
 */
import { describe, expect, it } from 'vitest';

import { FlagEmbedding, EmbeddingModel } from '../../embeddings/fastembed-inline/index.js';

const TEST_TIMEOUT_MS = 120_000; // first-run download budget; later runs are <2s.

function l2Norm(v: number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

describe('fastembed-inline integration', () => {
  it(
    'produces a 384-dim L2-normalized embedding for a single query',
    async () => {
      const model = await FlagEmbedding.init({
        model: EmbeddingModel.AllMiniLML6V2,
        showDownloadProgress: false,
      });
      const vec = await model.queryEmbed('the quick brown fox jumps over the lazy dog');
      expect(vec).toHaveLength(384);
      expect(l2Norm(vec)).toBeCloseTo(1.0, 5);
      // Output should be deterministic across runs.
      const vec2 = await model.queryEmbed('the quick brown fox jumps over the lazy dog');
      expect(vec2).toEqual(vec);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'produces distinct embeddings for distinct inputs and identical for identical inputs',
    async () => {
      const model = await FlagEmbedding.init({
        model: EmbeddingModel.AllMiniLML6V2,
        showDownloadProgress: false,
      });
      const batches: number[][] = [];
      for await (const batch of model.embed(['hello world', 'goodbye world', 'hello world'], 8)) {
        batches.push(...batch);
      }
      expect(batches).toHaveLength(3);
      // Same input → identical output (within float epsilon).
      for (let i = 0; i < batches[0].length; i++) {
        expect(batches[2][i]).toBeCloseTo(batches[0][i], 6);
      }
      // Different input → at least one component differs.
      let differs = 0;
      for (let i = 0; i < batches[0].length; i++) {
        if (Math.abs(batches[0][i] - batches[1][i]) > 1e-4) differs++;
      }
      expect(differs).toBeGreaterThan(10);
      // Each row is L2-normalized.
      for (const row of batches) {
        expect(l2Norm(row)).toBeCloseTo(1.0, 5);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
