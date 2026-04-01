/**
 * SONA Engine — Self-Optimizing Neural Architecture
 *
 * Pure TypeScript SONA engine implementation.
 * Implements rank-r Micro-LoRA adaptation, pattern clustering with
 * cosine similarity, trajectory-based learning, and EWC regularization.
 *
 * No external dependencies — uses only Float32Array math.
 *
 * @module sona-engine
 */

/** Full SONA configuration */
export interface JsSonaConfig {
  hiddenDim: number;
  embeddingDim: number;
  microLoraRank: number;
  baseLoraRank: number;
  microLoraLr: number;
  baseLoraLr: number;
  ewcLambda: number;
  patternClusters: number;
  trajectoryCapacity: number;
  qualityThreshold: number;
  enableSimd: boolean;
  backgroundIntervalMs?: number;
}

/** A learned pattern extracted from trajectories */
export interface JsLearnedPattern {
  patternType: string;
  avgQuality: number;
  embedding: Float32Array;
  usageCount: number;
}

interface TrajectoryRecord {
  queryEmbedding: number[];
  steps: Array<{ activations: number[]; attentionWeights: number[]; reward: number }>;
  domain: string;
}

/** Cosine similarity between two equal-length numeric arrays */
function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Element-wise mean of a list of equal-length arrays, returned as Float32Array */
function meanVectors(vectors: ArrayLike<number>[], dim: number): Float32Array {
  const out = new Float32Array(dim);
  if (vectors.length === 0) return out;
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/**
 * Self-Optimizing Neural Architecture engine.
 *
 * Provides Micro-LoRA adaptation, trajectory-based learning, pattern
 * clustering, and EWC-regularised weight updates — all in pure TypeScript.
 */
export class SonaEngine {
  // Config
  private readonly dim: number;
  private readonly rank: number;
  private readonly alpha: number;
  private readonly lr: number;
  private readonly ewcLambda: number;
  private readonly qualityThreshold: number;
  private readonly maxPatterns: number;
  private readonly maxTrajectories: number;
  private readonly backgroundIntervalMs: number;

  // LoRA matrices  (W' = W + scaling * B @ A @ input)
  private loraA: Float32Array; // rank × dim  (row-major)
  private loraB: Float32Array; // dim × rank  (row-major)
  private prevLoraA: Float32Array;
  private prevLoraB: Float32Array;
  private readonly scaling: number;

  // State
  private patterns: JsLearnedPattern[] = [];
  private trajectories: Map<number, TrajectoryRecord> = new Map();
  private nextTrajectoryId = 0;
  private totalTrajectories = 0;
  private enabled = true;
  private lastConsolidation = Date.now();

  constructor(dim: number, rank: number, alpha: number, lr: number);
  constructor(dim: number, rank: number, alpha: number, lr: number, _cfg?: Partial<JsSonaConfig>);
  constructor(dim: number, rank: number, alpha: number, lr: number, _cfg?: Partial<JsSonaConfig>) {
    this.dim = dim;
    this.rank = rank;
    this.alpha = alpha;
    this.lr = lr;
    this.scaling = alpha / rank;

    this.ewcLambda = _cfg?.ewcLambda ?? 2000;
    this.qualityThreshold = _cfg?.qualityThreshold ?? 0.5;
    this.maxPatterns = _cfg?.patternClusters ?? 50;
    this.maxTrajectories = _cfg?.trajectoryCapacity ?? 3000;
    this.backgroundIntervalMs = _cfg?.backgroundIntervalMs ?? 1800000;

    // A: small random / sqrt(rank);  B: zeros
    this.loraA = new Float32Array(rank * dim);
    const scale = 1 / Math.sqrt(rank);
    for (let i = 0; i < this.loraA.length; i++) {
      this.loraA[i] = (Math.random() * 2 - 1) * scale;
    }
    this.loraB = new Float32Array(dim * rank); // zeros

    this.prevLoraA = new Float32Array(this.loraA);
    this.prevLoraB = new Float32Array(this.loraB);
  }

  /** Create engine from a full JsSonaConfig */
  static withConfig(config: JsSonaConfig): SonaEngine {
    return new SonaEngine(
      config.embeddingDim,
      config.baseLoraRank,
      config.baseLoraRank, // alpha = rank (standard default)
      config.baseLoraLr,
      config,
    );
  }

  /** Begin a new trajectory. Returns a trajectory ID. */
  beginTrajectory(queryEmbedding: number[]): number {
    const id = this.nextTrajectoryId++;
    this.trajectories.set(id, { queryEmbedding, steps: [], domain: 'general' });
    // Evict oldest if over capacity
    if (this.trajectories.size > this.maxTrajectories) {
      const oldest = this.trajectories.keys().next().value!;
      this.trajectories.delete(oldest);
    }
    return id;
  }

  /** Record one step inside an active trajectory */
  addTrajectoryStep(
    trajectoryId: number,
    activations: number[],
    attentionWeights: number[],
    reward: number,
  ): void {
    const t = this.trajectories.get(trajectoryId);
    if (t) t.steps.push({ activations, attentionWeights, reward });
  }

  /** Attach a domain label to a trajectory */
  addTrajectoryContext(trajectoryId: number, domain: string): void {
    const t = this.trajectories.get(trajectoryId);
    if (t) t.domain = domain;
  }

  /** End a trajectory. If quality meets threshold, extract and store a pattern. */
  endTrajectory(trajectoryId: number, quality: number): void {
    const t = this.trajectories.get(trajectoryId);
    if (!t) return;
    this.totalTrajectories++;

    if (quality >= this.qualityThreshold && t.steps.length > 0) {
      const centroid = meanVectors(
        t.steps.map(s => s.activations),
        this.dim,
      );
      this.addPattern(centroid, t.domain, quality);
    }
    this.trajectories.delete(trajectoryId);
  }

  /**
   * Force a learning cycle.
   *
   * Overload 1 (no args): consolidate patterns, return status string.
   * Overload 2 (embedding + reward): learn a single embedding/reward pair.
   */
  forceLearn(): string;
  forceLearn(embedding: Float32Array, reward: number): void;
  forceLearn(embedding?: Float32Array, reward?: number): string | void {
    if (embedding !== undefined && reward !== undefined) {
      this.learnSingle(embedding, reward);
      return;
    }
    this.consolidatePatterns();
    return JSON.stringify({ status: 'consolidated', patterns: this.patterns.length });
  }

  /** Flush pending updates — snapshot current weights for EWC baseline */
  flush(): void {
    this.prevLoraA.set(this.loraA);
    this.prevLoraB.set(this.loraB);
  }

  /**
   * Background tick. Consolidates similar patterns if enough time has elapsed.
   * @returns Status string when consolidation ran, otherwise null.
   */
  tick(): string | null {
    const now = Date.now();
    if (now - this.lastConsolidation < this.backgroundIntervalMs) return null;
    this.lastConsolidation = now;
    const merged = this.consolidatePatterns();
    return merged > 0
      ? `consolidated ${merged} patterns, ${this.patterns.length} remaining`
      : null;
  }

  /**
   * Apply Micro-LoRA transform: output = input + scaling * B @ A @ input
   * @param queryArray - Input vector
   * @returns Adapted vector
   */
  applyMicroLora(queryArray: number[]): number[] {
    const n = Math.min(queryArray.length, this.dim);
    // hidden = A @ input  (rank-length vector)
    const hidden = new Float64Array(this.rank);
    for (let r = 0; r < this.rank; r++) {
      let sum = 0;
      const rowOff = r * this.dim;
      for (let d = 0; d < n; d++) sum += this.loraA[rowOff + d] * queryArray[d];
      hidden[r] = sum;
    }
    // delta = B @ hidden  (dim-length vector)
    const output: number[] = new Array(n);
    for (let d = 0; d < n; d++) {
      let sum = 0;
      const rowOff = d * this.rank;
      for (let r = 0; r < this.rank; r++) sum += this.loraB[rowOff + r] * hidden[r];
      output[d] = queryArray[d] + this.scaling * sum;
    }
    return output;
  }

  /**
   * Find the k most similar learned patterns to a query
   * @param queryArray - Query vector
   * @param k - Number of results
   */
  findPatterns(queryArray: number[], k: number): JsLearnedPattern[] {
    if (this.patterns.length === 0) return [];
    const scored = this.patterns.map(p => ({
      pattern: p,
      sim: cosineSimilarity(queryArray, p.embedding),
    }));
    scored.sort((a, b) => b.sim - a.sim);
    const results = scored.slice(0, k).map(s => {
      s.pattern.usageCount++;
      return s.pattern;
    });
    return results;
  }

  /** Return engine stats as a JSON string */
  getStats(): string {
    const avgQ =
      this.patterns.length > 0
        ? this.patterns.reduce((s, p) => s + p.avgQuality, 0) / this.patterns.length
        : 0;
    return JSON.stringify({
      total_trajectories: this.totalTrajectories,
      patterns_learned: this.patterns.length,
      avg_quality: Math.round(avgQ * 1000) / 1000,
      enabled: this.enabled,
      dim: this.dim,
      rank: this.rank,
    });
  }

  /** Check whether the engine is enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable or disable the engine */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Learn from a single embedding/reward pair.
   * Updates LoRA weights with EWC regularisation.
   */
  private learnSingle(embedding: Float32Array, reward: number): void {
    // Gradient direction: reward > 0 reinforces, < 0 suppresses
    const sign = reward >= 0 ? 1 : -1;
    const lr = this.lr * Math.abs(reward);

    for (let r = 0; r < this.rank; r++) {
      const rowOff = r * this.dim;
      for (let d = 0; d < this.dim; d++) {
        const grad = sign * embedding[d];
        const ewcPenalty = this.ewcLambda * (this.loraA[rowOff + d] - this.prevLoraA[rowOff + d]);
        this.loraA[rowOff + d] += lr * (grad - ewcPenalty);
      }
    }
    for (let d = 0; d < this.dim; d++) {
      const rowOff = d * this.rank;
      for (let r = 0; r < this.rank; r++) {
        const grad = sign * embedding[d];
        const ewcPenalty = this.ewcLambda * (this.loraB[rowOff + r] - this.prevLoraB[rowOff + r]);
        this.loraB[rowOff + r] += lr * (grad - ewcPenalty);
      }
    }

    // Also store as a pattern
    this.addPattern(new Float32Array(embedding), 'learned', Math.max(0, Math.min(1, (reward + 1) / 2)));
  }

  /** Insert or merge a pattern into the store */
  private addPattern(embedding: Float32Array, patternType: string, quality: number): void {
    // Check for similar existing pattern (merge if cosine > 0.95)
    for (const p of this.patterns) {
      if (cosineSimilarity(embedding, p.embedding) > 0.95) {
        // Running average update
        const total = p.usageCount + 1;
        p.avgQuality = (p.avgQuality * p.usageCount + quality) / total;
        for (let i = 0; i < this.dim && i < embedding.length; i++) {
          p.embedding[i] = (p.embedding[i] * p.usageCount + embedding[i]) / total;
        }
        p.usageCount = total;
        return;
      }
    }

    // New pattern
    if (this.patterns.length >= this.maxPatterns) {
      // Replace lowest-quality pattern
      let minIdx = 0;
      for (let i = 1; i < this.patterns.length; i++) {
        if (this.patterns[i].avgQuality < this.patterns[minIdx].avgQuality) minIdx = i;
      }
      if (quality > this.patterns[minIdx].avgQuality) {
        this.patterns[minIdx] = { patternType, avgQuality: quality, embedding, usageCount: 1 };
      }
      return;
    }
    this.patterns.push({ patternType, avgQuality: quality, embedding, usageCount: 1 });
  }

  /**
   * Consolidate similar patterns (cosine > 0.95).
   * @returns Number of patterns merged away
   */
  private consolidatePatterns(): number {
    let merged = 0;
    for (let i = 0; i < this.patterns.length; i++) {
      for (let j = i + 1; j < this.patterns.length; j++) {
        if (cosineSimilarity(this.patterns[i].embedding, this.patterns[j].embedding) > 0.95) {
          const a = this.patterns[i];
          const b = this.patterns[j];
          const total = a.usageCount + b.usageCount;
          for (let d = 0; d < a.embedding.length; d++) {
            a.embedding[d] = (a.embedding[d] * a.usageCount + b.embedding[d] * b.usageCount) / total;
          }
          a.avgQuality = (a.avgQuality * a.usageCount + b.avgQuality * b.usageCount) / total;
          a.usageCount = total;
          this.patterns.splice(j, 1);
          j--;
          merged++;
        }
      }
    }
    return merged;
  }
}
