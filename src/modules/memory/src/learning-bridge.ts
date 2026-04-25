/**
 * LearningBridge - Connects AutoMemoryBridge to NeuralLearningSystem
 *
 * When insights are recorded via AutoMemoryBridge, this module triggers
 * neural learning trajectories so the system continuously improves from
 * its own discoveries. The NeuralLearningSystem dependency is optional:
 * when unavailable, all operations degrade gracefully to no-ops.
 *
 * @module @moflo/memory/learning-bridge
 */

import { EventEmitter } from 'node:events';
import type { IMemoryBackend, MemoryEntry, SONAMode } from './types.js';
import type { MemoryInsight, InsightCategory } from './auto-memory-bridge.js';
import type { ControllerSpec } from './controller-spec.js';
import { locateCliEmbeddings } from './locate-cli-embeddings.js';

// ===== Types =====

/**
 * Factory function that returns a neural system instance.
 * Used for dependency injection so tests can supply a mock.
 */
export type NeuralLoader = () => Promise<any>;

/**
 * Factory function that returns an embedding service instance.
 * Used by the bridge to embed insight summaries — hash fallback was removed
 * in epic #527 so the bridge requires a real service (or a test mock).
 */
export type EmbeddingLoader = () => Promise<{
  embed(text: string): Promise<{ embedding: Float32Array | number[] }>;
} | null>;

/** Configuration for the LearningBridge */
export interface LearningBridgeConfig {
  /** SONA operating mode (default: 'balanced') */
  sonaMode?: SONAMode;
  /** Per-hour confidence decay rate (default: 0.005) */
  confidenceDecayRate?: number;
  /** Confidence boost per access (default: 0.03) */
  accessBoostAmount?: number;
  /** Maximum confidence value (default: 1.0) */
  maxConfidence?: number;
  /** Minimum confidence floor (default: 0.1) */
  minConfidence?: number;
  /** EWC regularization strength (default: 2000) */
  ewcLambda?: number;
  /** Min active trajectories before consolidation runs (default: 10) */
  consolidationThreshold?: number;
  /** Enable the bridge (default: true). When false all methods are no-ops */
  enabled?: boolean;
  /**
   * Optional factory for the neural learning system.
   * When provided, this replaces the default dynamic import of @moflo/neural.
   * Primarily used for testing.
   */
  neuralLoader?: NeuralLoader;
  /**
   * Optional factory for the embedding service used to embed insight summaries.
   * Defaults to a dynamic import of cli's embeddings module (fastembed provider).
   * Tests inject a deterministic mock.
   */
  embeddingLoader?: EmbeddingLoader;
}

/** Aggregated learning statistics */
export interface LearningStats {
  totalTrajectories: number;
  completedTrajectories: number;
  activeTrajectories: number;
  totalConsolidations: number;
  totalDecays: number;
  avgConfidenceBoost: number;
  neuralAvailable: boolean;
}

/** Result returned by consolidate() */
export interface ConsolidateResult {
  trajectoriesCompleted: number;
  patternsLearned: number;
  entriesUpdated: number;
  durationMs: number;
}

/** A single pattern match returned by findSimilarPatterns() */
export interface PatternMatch {
  content: string;
  similarity: number;
  category: string;
  confidence: number;
}

// ===== Defaults =====

/** Internal resolved config type where loaders stay optional */
type ResolvedConfig = Required<Omit<LearningBridgeConfig, 'neuralLoader' | 'embeddingLoader'>> & {
  neuralLoader?: NeuralLoader;
  embeddingLoader?: EmbeddingLoader;
};

const DEFAULT_CONFIG: ResolvedConfig = {
  sonaMode: 'balanced',
  confidenceDecayRate: 0.005,
  accessBoostAmount: 0.03,
  maxConfidence: 1.0,
  minConfidence: 0.1,
  ewcLambda: 2000,
  consolidationThreshold: 10,
  enabled: true,
};

const MS_PER_HOUR = 3_600_000;

// ===== LearningBridge =====

/**
 * Connects AutoMemoryBridge insights to the NeuralLearningSystem.
 *
 * @example
 * ```typescript
 * const bridge = new LearningBridge(memoryBackend);
 * await bridge.onInsightRecorded(insight, entryId);
 * await bridge.onInsightAccessed(entryId);
 * const result = await bridge.consolidate();
 * ```
 */
export class LearningBridge extends EventEmitter {
  private neural: any | null = null;
  private backend: IMemoryBackend;
  private config: ResolvedConfig;
  private activeTrajectories: Map<string, string> = new Map();
  private stats = {
    totalTrajectories: 0,
    completedTrajectories: 0,
    totalConsolidations: 0,
    totalDecays: 0,
    confidenceBoosts: 0,
    totalBoostAmount: 0,
  };
  private destroyed = false;
  private neuralInitPromise: Promise<void> | null = null;
  private embeddingService: {
    embed(text: string): Promise<{ embedding: Float32Array | number[] }>;
  } | null = null;
  private embeddingInitPromise: Promise<void> | null = null;

  constructor(backend: IMemoryBackend, config?: LearningBridgeConfig) {
    super();
    this.backend = backend;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===== Public API =====

  /**
   * Notify the bridge that an insight has been recorded in MofloDb.
   * Creates a learning trajectory so the neural system can track the
   * insight's lifecycle.
   */
  async onInsightRecorded(insight: MemoryInsight, entryId: string): Promise<void> {
    if (!this.config.enabled || this.destroyed) return;

    await this.initNeural();

    if (this.neural) {
      try {
        const trajectoryId = this.neural.beginTask(insight.summary, 'general');
        this.activeTrajectories.set(entryId, trajectoryId);
        this.stats.totalTrajectories++;

        const embedding = await this.embedText(insight.summary);
        this.neural.recordStep(trajectoryId, {
          action: `record:${insight.category}`,
          reward: insight.confidence,
          stateEmbedding: embedding,
        });
      } catch {
        // Neural system failure is non-fatal
      }
    }

    this.emit('insight:learning-started', { entryId, category: insight.category });
  }

  /**
   * Notify the bridge that an insight entry was accessed.
   * Boosts confidence in the backend and records a step in the
   * trajectory if one exists.
   */
  async onInsightAccessed(entryId: string): Promise<void> {
    if (!this.config.enabled || this.destroyed) return;

    const entry = await this.backend.get(entryId);
    if (!entry) return;

    const currentConf = (entry.metadata?.confidence as number) ?? 0.5;
    const newConf = Math.min(
      this.config.maxConfidence,
      currentConf + this.config.accessBoostAmount,
    );

    await this.backend.update(entryId, {
      metadata: { ...entry.metadata, confidence: newConf },
    });

    this.stats.confidenceBoosts++;
    this.stats.totalBoostAmount += this.config.accessBoostAmount;

    if (this.neural && this.activeTrajectories.has(entryId)) {
      try {
        const trajectoryId = this.activeTrajectories.get(entryId)!;
        this.neural.recordStep(trajectoryId, {
          action: 'access',
          reward: this.config.accessBoostAmount,
        });
      } catch {
        // Non-fatal
      }
    }

    this.emit('insight:accessed', { entryId, newConfidence: newConf });
  }

  /**
   * Consolidate active trajectories by completing them in the neural system.
   * Only runs when there are enough active trajectories to justify the cost.
   */
  async consolidate(): Promise<ConsolidateResult> {
    const startTime = Date.now();
    const earlyResult: ConsolidateResult = {
      trajectoriesCompleted: 0,
      patternsLearned: 0,
      entriesUpdated: 0,
      durationMs: 0,
    };

    if (!this.config.enabled || this.destroyed) {
      return earlyResult;
    }

    if (!this.neural || this.activeTrajectories.size < this.config.consolidationThreshold) {
      earlyResult.durationMs = Date.now() - startTime;
      return earlyResult;
    }

    let completed = 0;
    let patternsLearned = 0;
    const toRemove: string[] = [];

    const entries = Array.from(this.activeTrajectories.entries());
    for (const [entryId, trajectoryId] of entries) {
      try {
        await this.neural.completeTask(trajectoryId, 1.0);
        completed++;
        patternsLearned++;
        toRemove.push(entryId);
      } catch {
        // Skip failed completions
      }
    }

    for (const key of toRemove) {
      this.activeTrajectories.delete(key);
    }

    this.stats.completedTrajectories += completed;
    this.stats.totalConsolidations++;

    const result: ConsolidateResult = {
      trajectoriesCompleted: completed,
      patternsLearned,
      entriesUpdated: completed,
      durationMs: Date.now() - startTime,
    };

    this.emit('consolidation:completed', result);
    return result;
  }

  /**
   * Apply time-based confidence decay to entries in the given namespace.
   * Entries not accessed for more than one hour see their confidence reduced
   * proportionally to the hours elapsed, down to minConfidence.
   *
   * @returns number of entries whose confidence was lowered
   */
  async decayConfidences(namespace: string): Promise<number> {
    if (!this.config.enabled || this.destroyed) return 0;

    let entries: MemoryEntry[];
    try {
      entries = await this.backend.query({
        type: 'hybrid',
        namespace,
        limit: 1000,
      });
    } catch {
      return 0;
    }

    const now = Date.now();
    let decayed = 0;

    for (const entry of entries) {
      const hoursSinceUpdate = (now - entry.updatedAt) / MS_PER_HOUR;
      if (hoursSinceUpdate < 1) continue;

      const currentConf = (entry.metadata?.confidence as number) ?? 0.5;
      const newConf = Math.max(
        this.config.minConfidence,
        currentConf - this.config.confidenceDecayRate * hoursSinceUpdate,
      );

      if (newConf < currentConf) {
        try {
          await this.backend.update(entry.id, {
            metadata: { ...entry.metadata, confidence: newConf },
          });
          decayed++;
        } catch {
          // Skip failed updates
        }
      }
    }

    this.stats.totalDecays += decayed;
    return decayed;
  }

  /**
   * Find patterns similar to the given content using the neural system.
   * Returns an empty array when the neural system is unavailable.
   */
  async findSimilarPatterns(content: string, k: number = 5): Promise<PatternMatch[]> {
    if (!this.config.enabled || this.destroyed) return [];

    await this.initNeural();

    if (!this.neural) return [];

    try {
      const embedding = await this.embedText(content);
      const results = await this.neural.findPatterns(embedding, k);

      if (!Array.isArray(results)) return [];

      return results.map((r: any) => ({
        content: r.content ?? r.data ?? '',
        similarity: r.similarity ?? r.score ?? 0,
        category: r.category ?? 'unknown',
        confidence: r.confidence ?? r.reward ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /** Return aggregated learning statistics */
  getStats(): LearningStats {
    const avgBoost =
      this.stats.confidenceBoosts > 0
        ? this.stats.totalBoostAmount / this.stats.confidenceBoosts
        : 0;

    return {
      totalTrajectories: this.stats.totalTrajectories,
      completedTrajectories: this.stats.completedTrajectories,
      activeTrajectories: this.activeTrajectories.size,
      totalConsolidations: this.stats.totalConsolidations,
      totalDecays: this.stats.totalDecays,
      avgConfidenceBoost: avgBoost,
      neuralAvailable: this.neural !== null,
    };
  }

  /** Tear down the bridge. Subsequent method calls become no-ops. */
  destroy(): void {
    this.destroyed = true;
    this.activeTrajectories.clear();

    if (this.neural && typeof this.neural.cleanup === 'function') {
      try {
        this.neural.cleanup();
      } catch {
        // Best-effort cleanup
      }
    }

    this.neural = null;
    this.neuralInitPromise = null;
    this.removeAllListeners();
  }

  // ===== Private =====

  /**
   * Lazily attempt to load and initialize the NeuralLearningSystem.
   * The promise is cached so that repeated calls do not re-attempt
   * after a failure.
   */
  private async initNeural(): Promise<void> {
    if (this.neural) return;
    if (this.neuralInitPromise) {
      await this.neuralInitPromise;
      return;
    }

    this.neuralInitPromise = this.loadNeural();
    await this.neuralInitPromise;
  }

  private async loadNeural(): Promise<void> {
    try {
      if (this.config.neuralLoader) {
        // Use injected loader (test / custom integrations)
        this.neural = await this.config.neuralLoader();
        return;
      }

      const mod = await import('@moflo/neural' as string);
      const NeuralLearningSystem = mod.NeuralLearningSystem ?? mod.default;
      if (!NeuralLearningSystem) return;

      const instance = new NeuralLearningSystem({
        mode: this.config.sonaMode,
        ewcLambda: this.config.ewcLambda,
      });

      if (typeof instance.initialize === 'function') {
        await instance.initialize();
      }

      this.neural = instance;
    } catch {
      // @moflo/neural not installed or failed to initialize.
      // This is expected in many environments; degrade silently.
      this.neural = null;
    }
  }

  /**
   * Embed text for pattern matching inside the neural trajectory system.
   *
   * Lazily initializes the shared embedding service (fastembed-backed by
   * default) and returns its Float32Array output. When no embedding service
   * can be loaded, returns an empty Float32Array so the caller can skip the
   * step rather than poison the trajectory with fake vectors.
   */
  private async embedText(text: string): Promise<Float32Array> {
    await this.initEmbeddings();
    if (!this.embeddingService) return new Float32Array(0);
    try {
      const result = await this.embeddingService.embed(text);
      return result.embedding instanceof Float32Array
        ? result.embedding
        : new Float32Array(result.embedding);
    } catch {
      return new Float32Array(0);
    }
  }

  /**
   * Lazily load the embedding service. Uses an injected loader (tests) or
   * walks up to cli's compiled embeddings module (production). Failures leave
   * `embeddingService = null` so callers skip embedding without crashing.
   */
  private async initEmbeddings(): Promise<void> {
    if (this.embeddingService) return;
    if (this.embeddingInitPromise) {
      await this.embeddingInitPromise;
      return;
    }

    this.embeddingInitPromise = (async () => {
      try {
        if (this.config.embeddingLoader) {
          this.embeddingService = await this.config.embeddingLoader();
          return;
        }

        const url = locateCliEmbeddings();
        if (!url) return;
        const mod: any = await import(url);
        const create = mod.createEmbeddingService;
        if (typeof create !== 'function') return;

        this.embeddingService = create({
          provider: 'fastembed',
          dimensions: 384,
        });
      } catch {
        this.embeddingService = null;
      }
    })();

    await this.embeddingInitPromise;
  }
}

export const learningBridgeSpec: ControllerSpec = {
  name: 'learningBridge',
  level: 1,
  requires: ['backend'],
  enabledByDefault: true,
  create: ({ backend, config }) => {
    const lbConfig = config.memory?.learningBridge ?? {};
    return new LearningBridge(backend!, {
      sonaMode: lbConfig.sonaMode ?? config.neural?.sonaMode ?? 'balanced',
      confidenceDecayRate: lbConfig.confidenceDecayRate,
      accessBoostAmount: lbConfig.accessBoostAmount,
      consolidationThreshold: lbConfig.consolidationThreshold,
      enabled: true,
    });
  },
};

export default LearningBridge;
