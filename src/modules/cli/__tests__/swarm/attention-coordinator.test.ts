/**
 * AttentionCoordinator tests — issue #542.
 *
 * The prior implementation created hash-based embeddings inline. After #542
 * the coordinator takes an injected IEmbeddingProvider; these tests verify
 * the provider is actually called and that pairwise attention methods work
 * end-to-end with a deterministic mock.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AttentionCoordinator,
  createAttentionCoordinator,
  type AgentOutput,
  type IEmbeddingProvider,
} from '../../src/swarm/attention-coordinator.js';

/**
 * Deterministic mock provider. Every call returns the same fixed zero-filled
 * 64-dim vector; cosine similarity is then 0/0 → handled by the epsilon in
 * computeAttentionScore. Identity doesn't matter for these tests — we only
 * care that the provider is invoked and the coordinator completes.
 */
function createMockEmbeddingProvider(): IEmbeddingProvider {
  const vec = () => {
    const v = new Float32Array(64);
    v[0] = 1; // non-zero so cosine similarity is stable
    return v;
  };
  return {
    embed: vi.fn().mockImplementation(async () => vec()),
    batchEmbed: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => vec())
    ),
  };
}

function createOutput(id: string, content: string): AgentOutput {
  return { agentId: id, content, confidence: 0.8 };
}

describe('AttentionCoordinator (issue #542)', () => {
  it('throws when constructed without an embedding provider', () => {
    expect(() => new AttentionCoordinator(undefined as never)).toThrow(
      /IEmbeddingProvider/
    );
  });

  it('createAttentionCoordinator wires the provider through', () => {
    const provider = createMockEmbeddingProvider();
    const coord = createAttentionCoordinator(provider);
    expect(coord).toBeInstanceOf(AttentionCoordinator);
  });

  it('batch-embeds agent outputs on a flash coordination pass', async () => {
    const provider = createMockEmbeddingProvider();
    const coord = createAttentionCoordinator(provider);
    const outputs = [
      createOutput('a1', 'task one'),
      createOutput('a2', 'task two'),
      createOutput('a3', 'task three'),
    ];

    const result = await coord.coordinateAgents(outputs, 'flash');

    expect(result.success).toBe(true);
    expect(provider.batchEmbed).toHaveBeenCalledTimes(1);
    expect(provider.batchEmbed).toHaveBeenCalledWith([
      'task one',
      'task two',
      'task three',
    ]);
    // The coordinator caches the returned embeddings on each output.
    for (const o of outputs) {
      expect(o.embedding).toBeInstanceOf(Float32Array);
    }
  });

  it('skips the provider call when every output already carries an embedding', async () => {
    const provider = createMockEmbeddingProvider();
    const coord = createAttentionCoordinator(provider);
    const preEmbedded = [
      { ...createOutput('a1', 'x'), embedding: new Float32Array([1, 0]) },
      { ...createOutput('a2', 'y'), embedding: new Float32Array([0, 1]) },
    ];

    await coord.coordinateAgents(preEmbedded, 'flash');

    expect(provider.batchEmbed).not.toHaveBeenCalled();
  });

  it('embeds only the subset of outputs that are missing embeddings', async () => {
    const provider = createMockEmbeddingProvider();
    const coord = createAttentionCoordinator(provider);
    const outputs: AgentOutput[] = [
      { ...createOutput('a1', 'cached'), embedding: new Float32Array([1, 0]) },
      createOutput('a2', 'needs-embed'),
    ];

    await coord.coordinateAgents(outputs, 'flash');

    expect(provider.batchEmbed).toHaveBeenCalledTimes(1);
    expect(provider.batchEmbed).toHaveBeenCalledWith(['needs-embed']);
  });

  it('hyperbolic coordination triggers the batch embed', async () => {
    const provider = createMockEmbeddingProvider();
    const coord = createAttentionCoordinator(provider);
    const outputs = [createOutput('a1', 'x'), createOutput('a2', 'y')];

    const result = await coord.coordinateAgents(outputs, 'hyperbolic');

    expect(result.success).toBe(true);
    expect(provider.batchEmbed).toHaveBeenCalled();
  });
});
