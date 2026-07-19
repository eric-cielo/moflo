/**
 * ModelRouter — selection-bias regression tests for issue #891.
 *
 * These exercise the public `route()` API to ensure:
 *   1. preferCost / preferSpeed are honored
 *   2. The router does NOT force-escalate sonnet → opus on uncertainty alone
 *   3. Real-architecture tasks (≥2 high-complexity indicators) still pick opus
 *   4. The legacy `route(task, embedding[])` second-arg form still works
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ModelRouter,
  buildFallbackChain,
  staticFallbackChain,
  type ClaudeModel,
} from '../../movector/model-router';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ModelRouter selection (issue #891)', () => {
  let router: ModelRouter;
  let tmpStateDir: string;

  beforeEach(() => {
    // Isolate persistent state under a temp dir so tests don't pollute .swarm/
    tmpStateDir = mkdtempSync(join(tmpdir(), 'moflo-router-test-'));
    router = new ModelRouter({
      statePath: join(tmpStateDir, 'state.json'),
      autoSaveInterval: 1_000_000, // effectively disable auto-save
    });
  });

  afterEach(() => {
    try {
      rmSync(tmpStateDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  describe('AC1 — no force-escalate to opus on uncertainty', () => {
    it('returns sonnet for plain code-review task (the bug repro)', async () => {
      const result = await router.route(
        'Review 110-line single-file change in bin/session-start-launcher.mjs for reuse, quality, efficiency.'
      );
      expect(result.model).toBe('sonnet');
    });

    it('does not escalate single-keyword "audit" tasks to opus', async () => {
      const result = await router.route('Audit findings in this report.');
      expect(result.model).not.toBe('opus');
    });

    it('does not escalate single-keyword "review" tasks to opus', async () => {
      const result = await router.route('Review the diff in module.ts.');
      expect(result.model).not.toBe('opus');
    });
  });

  describe('AC2 — preferCost honors cheaper competitive model', () => {
    it('picks sonnet when preferCost is true on the bug repro', async () => {
      const result = await router.route(
        'Review 110-line single-file change in bin/session-start-launcher.mjs for reuse, quality, efficiency.',
        { preferCost: true }
      );
      expect(result.model).toBe('sonnet');
    });

    it('picks the cheaper model when two scores are within 0.1', async () => {
      // Synthetic scores: opus 0.80, sonnet 0.78, haiku 0.10 — within window 0.1.
      // preferCost should pick sonnet (cheaper) over opus.
      const scores = { haiku: 0.1, sonnet: 0.78, opus: 0.8, inherit: 0 } as Record<
        ClaudeModel,
        number
      >;
      const complexity = {
        score: 0.5,
        indicators: { high: [], medium: [], low: [] },
        features: {
          lexicalComplexity: 0,
          semanticDepth: 0,
          taskScope: 0,
          uncertaintyLevel: 0,
        },
      };
      // Access private selectModel via type assertion (test-only).
      const select = (router as unknown as {
        selectModel: (
          s: Record<ClaudeModel, number>,
          c: typeof complexity,
          o: { preferCost?: boolean }
        ) => { model: ClaudeModel };
      }).selectModel.bind(router);

      const out = select(scores, complexity, { preferCost: true });
      expect(out.model).toBe('sonnet');
    });

    it('does NOT pick a much-lower-scoring cheap model (only within window)', async () => {
      // Synthetic: opus 0.80, sonnet 0.50, haiku 0.40 — sonnet outside 0.1 window.
      const scores = { haiku: 0.4, sonnet: 0.5, opus: 0.8, inherit: 0 } as Record<
        ClaudeModel,
        number
      >;
      const complexity = {
        score: 0.7,
        indicators: { high: [], medium: [], low: [] },
        features: {
          lexicalComplexity: 0,
          semanticDepth: 0,
          taskScope: 0,
          uncertaintyLevel: 0,
        },
      };
      const select = (router as unknown as {
        selectModel: (
          s: Record<ClaudeModel, number>,
          c: typeof complexity,
          o: { preferCost?: boolean }
        ) => { model: ClaudeModel };
      }).selectModel.bind(router);

      const out = select(scores, complexity, { preferCost: true });
      expect(out.model).toBe('opus');
    });
  });

  describe('AC3 — real architecture still escalates to opus', () => {
    it('picks opus for "architect new auth system across 12 services"', async () => {
      const result = await router.route(
        'architect new auth system across 12 services'
      );
      expect(result.model).toBe('opus');
    });

    it('picks opus for "design distributed consensus algorithm with Byzantine fault tolerance"', async () => {
      const result = await router.route(
        'design distributed consensus algorithm with Byzantine fault tolerance'
      );
      expect(result.model).toBe('opus');
    });

    it('respects preferCost even on architecture tasks (cheaper-within-window)', async () => {
      // With preferCost, an architecture task picks the cheapest competitive model.
      // We assert it's NOT opus when sonnet is within 0.1 of opus's score.
      const result = await router.route(
        'architect new auth system across 12 services',
        { preferCost: true }
      );
      expect(result.model).not.toBe('opus');
    });
  });

  describe('AC4 — legacy embedding[] second-arg still works', () => {
    it('accepts a number[] as the legacy embedding parameter', async () => {
      const embedding = new Array(64).fill(0).map((_, i) => i / 64);
      const result = await router.route('simple task', embedding);
      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('complexity');
    });
  });

  describe('preferSpeed mirror behaviour', () => {
    it('picks the faster model when scores are within 0.1', () => {
      const scores = { haiku: 0.78, sonnet: 0.8, opus: 0.4, inherit: 0 } as Record<
        ClaudeModel,
        number
      >;
      const complexity = {
        score: 0.3,
        indicators: { high: [], medium: [], low: [] },
        features: {
          lexicalComplexity: 0,
          semanticDepth: 0,
          taskScope: 0,
          uncertaintyLevel: 0,
        },
      };
      const select = (router as unknown as {
        selectModel: (
          s: Record<ClaudeModel, number>,
          c: typeof complexity,
          o: { preferSpeed?: boolean }
        ) => { model: ClaudeModel };
      }).selectModel.bind(router);

      const out = select(scores, complexity, { preferSpeed: true });
      expect(out.model).toBe('haiku');
    });
  });

  describe('result shape', () => {
    it('reports the selected model in costMultiplier and excludes it from alternatives', async () => {
      const result = await router.route(
        'Review 110-line single-file change in bin/session-start-launcher.mjs for reuse, quality, efficiency.'
      );
      expect(result.model).toBe('sonnet');
      expect(result.alternatives.find((a) => a.model === 'sonnet')).toBeUndefined();
      expect(result.alternatives.find((a) => a.model === 'opus')).toBeDefined();
      expect(result.costMultiplier).toBeLessThan(1); // sonnet < opus
    });
  });

  describe('fallbackModel chain (#1272)', () => {
    const noFailures: Record<ClaudeModel, number> = {
      haiku: 0,
      sonnet: 0,
      opus: 0,
      inherit: 0,
    };

    it('buildFallbackChain excludes the primary and inherit, orders by score', () => {
      const scores = { haiku: 0.1, sonnet: 0.5, opus: 0.9, inherit: 0.5 } as Record<
        ClaudeModel,
        number
      >;
      const chain = buildFallbackChain(scores, noFailures, 5, 'haiku');
      // primary (haiku) and inherit excluded; opus > sonnet by score.
      expect(chain).toEqual(['opus', 'sonnet']);
    });

    it('buildFallbackChain drops zero-score models (never useful fallbacks)', () => {
      const scores = { haiku: 0, sonnet: 0.5, opus: 0.9, inherit: 0 } as Record<
        ClaudeModel,
        number
      >;
      const chain = buildFallbackChain(scores, noFailures, 5, 'sonnet');
      expect(chain).toEqual(['opus']); // haiku (0) dropped, sonnet is primary
    });

    it('buildFallbackChain demotes an OPEN-circuit tier to the tail despite high score', () => {
      const scores = { haiku: 0.1, sonnet: 0.5, opus: 0.9, inherit: 0 } as Record<
        ClaudeModel,
        number
      >;
      // opus circuit is open (5 >= threshold 5) → tail despite the best score.
      const failures = { ...noFailures, opus: 5 };
      const chain = buildFallbackChain(scores, failures, 5, 'haiku');
      expect(chain).toEqual(['sonnet', 'opus']);
    });

    it('route() returns a chain that excludes the primary and lists real tiers', async () => {
      const result = await router.route('fix a simple typo in the readme comment');
      expect(result.model).toBe('haiku');
      expect(result.fallbackModel).not.toContain('haiku');
      expect(result.fallbackModel).not.toContain('inherit');
      expect(result.fallbackModel).toContain('sonnet');
      expect(result.fallbackModel).toContain('opus');
    });

    it('route() demotes a tier to the chain tail once its circuit opens', async () => {
      const task = 'fix a simple typo in the readme comment';
      const before = await router.route(task);
      expect(before.fallbackModel[0]).toBe('sonnet'); // highest-scoring fallback

      // Open sonnet's circuit (default threshold 5).
      for (let i = 0; i < 5; i++) router.recordOutcome(task, 'sonnet', 'failure');

      const after = await router.route(task);
      // sonnet demoted to the tail; opus (healthy) now leads.
      expect(after.fallbackModel[0]).toBe('opus');
      expect(after.fallbackModel[after.fallbackModel.length - 1]).toBe('sonnet');
    });

    it('staticFallbackChain gives a capability-ordered chain excluding primary + inherit', () => {
      // Derived from MODEL_CAPABILITIES cost tiers: opus > sonnet > haiku.
      expect(staticFallbackChain('sonnet')).toEqual(['opus', 'haiku']);
      expect(staticFallbackChain('haiku')).toEqual(['opus', 'sonnet']);
      expect(staticFallbackChain('opus')).toEqual(['sonnet', 'haiku']);
      expect(staticFallbackChain('sonnet')).not.toContain('inherit');
    });
  });
});
