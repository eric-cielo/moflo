/**
 * SemanticRouter — moflo-owned intent router (epic #464 Phase C2).
 *
 * Replaces `agentdb.SemanticRouter`. Pure-JS keyword + optional embedding
 * cosine scoring to route a task description to an intent (category) and a
 * suggested list of agents.
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   const router = new SemanticRouter();
 *   await router.initialize();
 *   const result = await router.route(task, { context }?);
 *   // result: { route, confidence, agents, category, score, suggestedAgents }
 *
 * Agentdb's impl also uses embeddings — we accept an optional embedder,
 * fall back to keyword scoring when none is provided. Either path is
 * deterministic and fast enough for routing decisions.
 */

import { cosine, toFloat32 } from './_shared.js';
import type { ControllerSpec } from '../controller-spec.js';

export interface SemanticRouterIntent {
  name: string;
  keywords: string[];
  agents: string[];
  category?: string;
}

export interface SemanticRouteResult {
  route: string;
  category: string;
  confidence: number;
  score: number;
  agents: string[];
  suggestedAgents: string[];
}

export interface SemanticRouterConfig {
  intents?: SemanticRouterIntent[];
  embedder?: (text: string) => Promise<Float32Array | number[]>;
  /** Minimum confidence; below this we fall through to a 'general' route. */
  minConfidence?: number;
}

const DEFAULT_INTENTS: SemanticRouterIntent[] = [
  {
    name: 'code',
    category: 'development',
    keywords: ['code', 'function', 'class', 'typescript', 'javascript', 'refactor', 'implement', 'bug', 'fix'],
    agents: ['coder', 'backend-dev', 'reviewer'],
  },
  {
    name: 'memory',
    category: 'storage',
    keywords: ['memory', 'store', 'retrieve', 'search', 'embedding', 'vector', 'recall', 'persist'],
    agents: ['memory-specialist', 'swarm-memory-manager'],
  },
  {
    name: 'spell',
    category: 'workflow',
    keywords: ['spell', 'workflow', 'orchestrate', 'cast', 'pipeline', 'step'],
    agents: ['planner', 'sparc-orchestrator'],
  },
  {
    name: 'hooks',
    category: 'automation',
    keywords: ['hook', 'pre-task', 'post-task', 'event', 'trigger', 'automation'],
    agents: ['cicd-engineer', 'workflow-automation'],
  },
  {
    name: 'security',
    category: 'security',
    keywords: ['security', 'vulnerability', 'cve', 'audit', 'threat', 'permission', 'auth'],
    agents: ['security-auditor', 'security-architect'],
  },
  {
    name: 'neural',
    category: 'ml',
    keywords: ['neural', 'train', 'model', 'learning', 'reinforcement', 'sona', 'reasoningbank'],
    agents: ['ml-developer', 'safla-neural'],
  },
  {
    name: 'test',
    category: 'quality',
    keywords: ['test', 'vitest', 'unit', 'integration', 'tdd', 'coverage', 'assertion'],
    agents: ['tester', 'tdd-london-swarm'],
  },
  {
    name: 'github',
    category: 'integration',
    keywords: ['github', 'pr', 'pull request', 'issue', 'release', 'commit', 'branch'],
    agents: ['pr-manager', 'github-modes', 'release-manager'],
  },
];

export class SemanticRouter {
  private intents: SemanticRouterIntent[];
  private embedder?: SemanticRouterConfig['embedder'];
  private minConfidence: number;
  private intentEmbeddings: Map<string, Float32Array> = new Map();
  private initialized = false;

  constructor(config: SemanticRouterConfig = {}) {
    this.intents = (config.intents && config.intents.length > 0 ? config.intents : DEFAULT_INTENTS).map(cloneIntent);
    this.embedder = config.embedder;
    this.minConfidence = typeof config.minConfidence === 'number' ? config.minConfidence : 0.1;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.embedder) {
      for (const intent of this.intents) {
        const text = intent.keywords.join(' ');
        try {
          const vec = await this.embedder(text);
          this.intentEmbeddings.set(intent.name, toFloat32(vec));
        } catch {
          // If embedder throws, we silently drop the embedding for this intent.
          // Keyword scoring still works.
        }
      }
    }
    this.initialized = true;
  }

  async route(input: string, _context?: Record<string, unknown>): Promise<SemanticRouteResult> {
    if (!this.initialized) await this.initialize();
    const text = typeof input === 'string' ? input : String(input ?? '');
    const lower = text.toLowerCase();

    let best: { intent: SemanticRouterIntent; score: number } | null = null;

    // Embedding score path (if available).
    if (this.embedder && this.intentEmbeddings.size > 0) {
      try {
        const queryVec = toFloat32(await this.embedder(text));
        for (const intent of this.intents) {
          const iv = this.intentEmbeddings.get(intent.name);
          if (!iv) continue;
          const score = cosine(queryVec, iv);
          if (!best || score > best.score) best = { intent, score };
        }
      } catch {
        // Fall through to keyword scoring.
      }
    }

    // Keyword score path — always runs, so we can override or fill in.
    let keywordBest: { intent: SemanticRouterIntent; score: number } | null = null;
    for (const intent of this.intents) {
      const score = keywordScore(lower, intent.keywords);
      if (!keywordBest || score > keywordBest.score) keywordBest = { intent, score };
    }

    // Blend: if no embedding winner, use keyword; else average with keyword.
    if (!best) {
      best = keywordBest;
    } else if (keywordBest) {
      best = {
        intent: keywordBest.score > best.score ? keywordBest.intent : best.intent,
        score: (best.score + keywordBest.score) / 2,
      };
    }

    if (!best || best.score < this.minConfidence) {
      return {
        route: 'general',
        category: 'general',
        confidence: best?.score ?? 0,
        score: best?.score ?? 0,
        agents: [],
        suggestedAgents: [],
      };
    }

    const { intent, score } = best;
    return {
      route: intent.name,
      category: intent.category ?? intent.name,
      confidence: Math.min(1, score),
      score,
      agents: [...intent.agents],
      suggestedAgents: [...intent.agents],
    };
  }

  /** Test/admin helper — total intent count. */
  intentCount(): number {
    return this.intents.length;
  }
}

function cloneIntent(i: SemanticRouterIntent): SemanticRouterIntent {
  return {
    name: i.name,
    keywords: [...i.keywords],
    agents: [...i.agents],
    category: i.category,
  };
}

function keywordScore(lowerInput: string, keywords: string[]): number {
  if (!lowerInput) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    if (lowerInput.includes(kw.toLowerCase())) hits++;
  }
  return keywords.length === 0 ? 0 : hits / keywords.length;
}

export const semanticRouterSpec: ControllerSpec = {
  name: 'semanticRouter',
  level: 4,
  enabledByDefault: true,
  create: async () => {
    const router = new SemanticRouter();
    await router.initialize();
    return router;
  },
};

export default SemanticRouter;
