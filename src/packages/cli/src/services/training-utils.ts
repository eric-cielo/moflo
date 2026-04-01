/**
 * Training Utility Classes — Pure TypeScript
 *
 * Lightweight pure TS training utilities
 * helper types: AdamW optimiser, InfoNCE loss, curriculum scheduler,
 * hard negative miner, trajectory ring buffer, and scoped LoRA.
 *
 * @module training-utils
 */

import {
  LoRAAdapter,
  createLoRAAdapter,
} from '../movector/lora-adapter.js';

// ============================================================================
// AdamW optimiser
// ============================================================================

/** AdamW optimiser — maintains first/second moment estimates with weight decay */
export class AdamWOptimizer {
  private m: Float32Array | null = null;
  private v: Float32Array | null = null;
  private t = 0;
  constructor(
    private lr: number,
    private beta1: number,
    private beta2: number,
    private eps: number,
    private weightDecay: number,
  ) {}
  step(params: Float32Array, grads: Float32Array): Float32Array {
    const n = params.length;
    if (!this.m) { this.m = new Float32Array(n); this.v = new Float32Array(n); }
    this.t++;
    const out = new Float32Array(n);
    const m = this.m!, v = this.v!;
    for (let i = 0; i < n; i++) {
      m[i] = this.beta1 * m[i] + (1 - this.beta1) * grads[i];
      v[i] = this.beta2 * v[i] + (1 - this.beta2) * grads[i] * grads[i];
      const mHat = m[i] / (1 - this.beta1 ** this.t);
      const vHat = v[i] / (1 - this.beta2 ** this.t);
      out[i] = params[i] - this.lr * (mHat / (Math.sqrt(vHat) + this.eps) + this.weightDecay * params[i]);
    }
    return out;
  }
}

// ============================================================================
// InfoNCE contrastive loss
// ============================================================================

export class InfoNceLoss {
  constructor(private temperature: number) {}
  private dot(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }
  compute(anchor: Float32Array, positives: Float32Array[], negatives: Float32Array[]): number {
    const posScores = positives.map(p => Math.exp(this.dot(anchor, p) / this.temperature));
    const negScores = negatives.map(n => Math.exp(this.dot(anchor, n) / this.temperature));
    const posSum = posScores.reduce((a, b) => a + b, 0);
    const allSum = posSum + negScores.reduce((a, b) => a + b, 0);
    return allSum > 0 ? -Math.log(posSum / allSum + 1e-10) : 0;
  }
  backward(anchor: Float32Array, positives: Float32Array[], negatives: Float32Array[]): Float32Array {
    const dim = anchor.length;
    const grad = new Float32Array(dim);
    const allVecs = [...positives, ...negatives];
    const scores = allVecs.map(v => Math.exp(this.dot(anchor, v) / this.temperature));
    const total = scores.reduce((a, b) => a + b, 0);
    for (let vi = 0; vi < allVecs.length; vi++) {
      const weight = scores[vi] / (total + 1e-10);
      const isPos = vi < positives.length;
      const sign = isPos ? (weight - 1 / positives.length) : weight;
      for (let d = 0; d < dim; d++) grad[d] += sign * allVecs[vi][d] / this.temperature;
    }
    return grad;
  }
}

// ============================================================================
// Curriculum scheduler — linear warmup then cosine decay
// ============================================================================

export class CurriculumScheduler {
  constructor(private totalSteps: number, private warmupSteps: number) {}
  getDifficulty(step: number): number {
    if (step < this.warmupSteps) return step / this.warmupSteps;
    const t = (step - this.warmupSteps) / Math.max(1, this.totalSteps - this.warmupSteps);
    return 0.5 * (1 + Math.cos(Math.PI * t));
  }
}

// ============================================================================
// Hard negative miner — selects closest non-positive candidates
// ============================================================================

export class HardNegativeMiner {
  constructor(private k: number, _strategy?: string) {}
  private dot(a: Float32Array, b: Float32Array): number {
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s;
  }
  mine(anchor: Float32Array, candidates: Float32Array[]): number[] {
    const scored = candidates.map((c, i) => ({ i, s: this.dot(anchor, c) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, this.k).map(x => x.i);
  }
}

// ============================================================================
// Trajectory ring buffer (replaces WasmTrajectoryBuffer)
// ============================================================================

export interface TrajectoryEntry {
  embedding: Float32Array;
  operatorType: number;
  attentionType: number;
  improvement: number;
}

export class TrajectoryBuffer {
  private buf: TrajectoryEntry[];
  private head = 0;
  private count = 0;
  constructor(private capacity: number, private _dim: number) {
    this.buf = new Array(capacity);
  }
  record(embedding: Float32Array, opType: number, attnType: number, execMs: number, baseMs: number): void {
    const improvement = baseMs > 0 ? (baseMs - execMs) / baseMs : 0;
    this.buf[this.head] = { embedding, operatorType: opType, attentionType: attnType, improvement };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  is_empty(): boolean { return this.count === 0; }
  total_count(): bigint { return BigInt(this.count); }
  success_rate(): number {
    if (!this.count) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) if (this.buf[i].improvement > 0) s++;
    return s / this.count;
  }
  mean_improvement(): number {
    if (!this.count) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.buf[i].improvement;
    return s / this.count;
  }
  best_improvement(): number {
    let best = -Infinity;
    for (let i = 0; i < this.count; i++) if (this.buf[i].improvement > best) best = this.buf[i].improvement;
    return best === -Infinity ? 0 : best;
  }
  high_quality_count(threshold: number): number {
    let c = 0;
    for (let i = 0; i < this.count; i++) if (this.buf[i].improvement >= threshold) c++;
    return c;
  }
  variance(): number {
    if (this.count < 2) return 0;
    const mean = this.mean_improvement();
    let s = 0;
    for (let i = 0; i < this.count; i++) s += (this.buf[i].improvement - mean) ** 2;
    return s / (this.count - 1);
  }
  reset(): void { this.head = 0; this.count = 0; }
}

// ============================================================================
// Scoped LoRA — one LoRAAdapter per operator type (replaces WasmScopedLoRA)
// ============================================================================

export class ScopedLoRA {
  private adapters = new Map<number, LoRAAdapter>();
  constructor(private dim: number, private alpha: number, private lr: number) {}

  private getAdapter(opType: number): LoRAAdapter {
    let a = this.adapters.get(opType);
    if (!a) {
      a = createLoRAAdapter({ rank: 2, alpha: this.alpha, inputDim: this.dim, outputDim: this.dim, learningRate: this.lr });
      this.adapters.set(opType, a);
    }
    return a;
  }
  adapt(opType: number, gradient: Float32Array): void {
    this.getAdapter(opType).train(new Float32Array(this.dim), gradient);
  }
  forward(opType: number, input: Float32Array): Float32Array {
    return this.getAdapter(opType).adapt(input).adapted;
  }
  deltaNorm(opType: number): number { return this.getAdapter(opType).getStats().avgAdaptationNorm; }
  adaptCount(opType: number): bigint { return BigInt(this.getAdapter(opType).getStats().totalUpdates); }
  totalAdaptCount(): bigint {
    let c = 0; this.adapters.forEach(a => c += a.getStats().totalUpdates); return BigInt(c);
  }
  totalForwardCount(): bigint {
    let c = 0; this.adapters.forEach(a => c += a.getStats().totalAdaptations); return BigInt(c);
  }
  resetAll(): void { this.adapters.forEach(a => a.reset()); }
}
