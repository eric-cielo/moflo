import { describe, it, expect } from 'vitest';
import { SemanticRouter } from './semantic-router.js';

describe('SemanticRouter', () => {
  it('initializes with default intents', async () => {
    const r = new SemanticRouter();
    await r.initialize();
    expect(r.intentCount()).toBeGreaterThan(0);
  });

  it('routes code-related tasks to the code intent', async () => {
    const r = new SemanticRouter();
    await r.initialize();
    const result = await r.route('refactor this typescript function to fix the bug');
    expect(result.route).toBe('code');
    expect(result.category).toBe('development');
    expect(result.agents.length).toBeGreaterThan(0);
  });

  it('routes memory tasks to the memory intent', async () => {
    const r = new SemanticRouter();
    const result = await r.route('search the memory store for embeddings');
    expect(result.route).toBe('memory');
    expect(result.category).toBe('storage');
  });

  it('returns general/low-confidence for unrelated input', async () => {
    const r = new SemanticRouter({ minConfidence: 0.2 });
    const result = await r.route('banana xyzzy grommet');
    expect(result.route).toBe('general');
    expect(result.confidence).toBeLessThan(0.2);
  });

  it('accepts a custom intent set', async () => {
    const r = new SemanticRouter({
      intents: [
        { name: 'alpha', keywords: ['alpha'], agents: ['a'] },
        { name: 'beta', keywords: ['beta'], agents: ['b'] },
      ],
      minConfidence: 0.1,
    });
    const result = await r.route('ALPHA is the test');
    expect(result.route).toBe('alpha');
    expect(result.agents).toEqual(['a']);
  });

  it('blends embedding scores with keyword scores when embedder provided', async () => {
    const embedder = async (text: string): Promise<Float32Array> => {
      // Pretend every text maps to the same vector except "alpha" which
      // aligns strongly with the 'alpha' intent.
      if (text.toLowerCase().includes('alpha')) return Float32Array.from([1, 0]);
      return Float32Array.from([0, 1]);
    };
    const r = new SemanticRouter({
      intents: [
        { name: 'alpha', keywords: ['alpha'], agents: ['a'] },
        { name: 'beta', keywords: ['beta'], agents: ['b'] },
      ],
      embedder,
      minConfidence: 0,
    });
    await r.initialize();
    const result = await r.route('alpha case');
    expect(result.route).toBe('alpha');
  });

  it('degrades to keyword scoring if embedder throws', async () => {
    const embedder = async (): Promise<Float32Array> => {
      throw new Error('boom');
    };
    const r = new SemanticRouter({
      intents: [{ name: 'alpha', keywords: ['alpha'], agents: ['a'] }],
      embedder,
      minConfidence: 0,
    });
    await r.initialize();
    const result = await r.route('alpha');
    expect(result.route).toBe('alpha');
  });

  it('handles non-string input safely', async () => {
    const r = new SemanticRouter({ minConfidence: 0.2 });
    const result = await r.route(undefined as any);
    expect(result.route).toBe('general');
  });
});
