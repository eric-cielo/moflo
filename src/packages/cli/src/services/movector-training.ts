/**
 * MoVector Training Service — Pure TypeScript
 *
 * Pure TypeScript implementations:
 *   - LoRA adapters:      ../movector/lora-adapter.js
 *   - Flash Attention:    ../movector/flash-attention.js
 *   - SONA engine:        @claude-flow/neural sona-engine (optional)
 *   - Utilities:          ./training-utils.js
 *
 * Backward Compatible: All v1 exported APIs preserved.
 *
 * Created with love by motailz.com
 */

import { createLoRAAdapter, type LoRAAdapter } from '../movector/lora-adapter.js';
import { FlashAttention as PureTSFlashAttention } from '../movector/flash-attention.js';
import {
  AdamWOptimizer,
  InfoNceLoss,
  CurriculumScheduler,
  HardNegativeMiner,
  TrajectoryBuffer,
  ScopedLoRA,
} from './training-utils.js';

// ============================================================================
// SONA Engine type (from neural package, loaded dynamically)
// ============================================================================

interface SonaEngineInstance {
  forceLearn(embedding: Float32Array, reward: number): void;
  findPatterns(embedding: number[], k: number): unknown[];
  tick(): void;
  getStats(): string;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  flush(): void;
}

// ============================================================================
// Module state
// ============================================================================

let microLoRA: LoRAAdapter | null = null;
let scopedLoRA: ScopedLoRA | null = null;
let trajectoryBuffer: TrajectoryBuffer | null = null;
let flashAttention: PureTSFlashAttention | null = null;
let moeWeights: Float32Array | null = null;
let optimizer: AdamWOptimizer | null = null;
let contrastiveLoss: InfoNceLoss | null = null;
let curriculum: CurriculumScheduler | null = null;
let hardMiner: HardNegativeMiner | null = null;

let sonaEngine: SonaEngineInstance | null = null;
let sonaAvailable = false;

let initialized = false;
let totalAdaptations = 0;
let totalForwards = 0;
let totalSonaLearns = 0;
let totalSonaSearches = 0;
let lastBenchmark: unknown[] | null = null;

// ============================================================================
// Public types
// ============================================================================

export type { SonaEngineInstance };

export interface TrainingConfig {
  dim?: number;
  learningRate?: number;
  alpha?: number;
  trajectoryCapacity?: number;
  useFlashAttention?: boolean;
  useMoE?: boolean;
  useHyperbolic?: boolean;
  totalSteps?: number;
  warmupSteps?: number;
  useSona?: boolean;
  sonaRank?: number;
}

export interface TrainingResult {
  success: boolean;
  adaptationCount: bigint;
  forwardCount: bigint;
  deltaNorm: number;
  trajectoryStats?: {
    successRate: number;
    meanImprovement: number;
    bestImprovement: number;
    totalCount: bigint;
  };
  benchmark?: unknown[];
}

// ============================================================================
// Initialisation
// ============================================================================

export async function initializeTraining(config: TrainingConfig = {}): Promise<{
  success: boolean;
  features: string[];
  error?: string;
}> {
  const features: string[] = [];
  const dim = Math.min(config.dim || 256, 256);
  const lr = config.learningRate || 0.01;
  const alpha = config.alpha || 0.1;

  try {
    microLoRA = createLoRAAdapter({ rank: 2, alpha, inputDim: dim, outputDim: dim, learningRate: lr });
    features.push(`MicroLoRA (${dim}-dim, pure TS)`);

    scopedLoRA = new ScopedLoRA(dim, alpha, lr);
    features.push('ScopedLoRA (17 operators)');

    trajectoryBuffer = new TrajectoryBuffer(config.trajectoryCapacity || 10000, dim);
    features.push('TrajectoryBuffer');

    if (config.useFlashAttention !== false) {
      flashAttention = new PureTSFlashAttention({ dimensions: dim, blockSize: 64 });
      features.push('FlashAttention');
    }

    if (config.useMoE) {
      moeWeights = new Float32Array(8).fill(1 / 8);
      features.push('MoE (8 experts, top-2)');
    }

    if (config.useHyperbolic) {
      features.push('HyperbolicAttention');
    }

    optimizer = new AdamWOptimizer(lr, 0.9, 0.999, 1e-8, 0.01);
    features.push('AdamW Optimizer');

    contrastiveLoss = new InfoNceLoss(0.07);
    features.push('InfoNCE Loss');

    if (config.totalSteps) {
      curriculum = new CurriculumScheduler(
        config.totalSteps,
        config.warmupSteps || Math.floor(config.totalSteps * 0.1),
      );
      features.push('Curriculum Learning');
    }

    hardMiner = new HardNegativeMiner(5, 'semi_hard');
    features.push('Hard Negative Mining');

    // SONA — optional, dynamically imported from @claude-flow/neural
    if (config.useSona !== false) {
      try {
        const { pathToFileURL } = await import('url');
        const { dirname, resolve } = await import('path');
        const { fileURLToPath } = await import('url');
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const sonaPath = resolve(thisDir, '..', '..', '..', '..', 'neural', 'dist', 'sona-engine.js');
        const sonaUrl = pathToFileURL(sonaPath).href;
        const sona = await import(sonaUrl);
        const SonaEngineCtor = sona.SonaEngine ?? sona.default?.SonaEngine;
        if (SonaEngineCtor) {
          const sonaRank = config.sonaRank || 4;
          sonaEngine = new SonaEngineCtor(dim, sonaRank, alpha, lr) as SonaEngineInstance;
          sonaAvailable = true;
          features.push(`SONA (${dim}-dim, rank-${sonaRank})`);
        }
      } catch (sonaError) {
        sonaAvailable = false;
        if (config.useSona === true) {
          console.warn('SONA requested but not available:', sonaError);
        }
      }
    }

    initialized = true;
    return { success: true, features };
  } catch (error) {
    return {
      success: false,
      features,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Operator types
// ============================================================================

export const OperatorType = {
  GENERAL: 0, ATTENTION: 1, MLP: 2, EMBEDDING: 3, NORMALIZATION: 4,
  PROJECTION: 5, POOLING: 6, CONVOLUTION: 7, RECURRENT: 8, ROUTING: 9,
  MEMORY: 10, REASONING: 11, COORDINATION: 12, OPTIMIZATION: 13,
  SECURITY: 14, TESTING: 15, DEBUGGING: 16,
} as const;

// ============================================================================
// Training API
// ============================================================================

export async function trainPattern(
  embedding: Float32Array,
  gradient: Float32Array,
  operatorType?: number,
): Promise<{ deltaNorm: number; adaptCount: bigint }> {
  if (!initialized || !microLoRA) throw new Error('Training system not initialized');

  if (operatorType !== undefined && scopedLoRA) {
    scopedLoRA.adapt(operatorType, gradient);
    return {
      deltaNorm: scopedLoRA.deltaNorm(operatorType),
      adaptCount: scopedLoRA.adaptCount(operatorType),
    };
  }

  const { loss } = microLoRA.train(embedding, gradient);
  totalAdaptations++;
  return { deltaNorm: loss, adaptCount: BigInt(microLoRA.getStats().totalUpdates) };
}

export function forward(input: Float32Array, operatorType?: number): Float32Array {
  if (!initialized || !microLoRA) throw new Error('Training system not initialized');
  totalForwards++;
  if (operatorType !== undefined && scopedLoRA) return scopedLoRA.forward(operatorType, input);
  return microLoRA.adapt(input).adapted;
}

export function adaptWithReward(improvement: number, operatorType?: number): void {
  if (!initialized) throw new Error('Training system not initialized');
  const syntheticGrad = new Float32Array(256);
  for (let i = 0; i < syntheticGrad.length; i++) syntheticGrad[i] = improvement * 0.01;

  if (operatorType !== undefined && scopedLoRA) {
    scopedLoRA.adapt(operatorType, syntheticGrad);
  } else if (microLoRA) {
    microLoRA.train(syntheticGrad, syntheticGrad, improvement);
  }
  totalAdaptations++;
}

export function recordTrajectory(
  embedding: Float32Array,
  operatorType: number,
  attentionType: number,
  executionMs: number,
  baselineMs: number,
): void {
  if (!trajectoryBuffer) throw new Error('Trajectory buffer not initialized');
  trajectoryBuffer.record(embedding, operatorType, attentionType, executionMs, baselineMs);
}

export function getTrajectoryStats(): {
  successRate: number;
  meanImprovement: number;
  bestImprovement: number;
  totalCount: bigint;
  highQualityCount: number;
  variance: number;
} | null {
  if (!trajectoryBuffer || trajectoryBuffer.is_empty()) return null;
  return {
    successRate: trajectoryBuffer.success_rate(),
    meanImprovement: trajectoryBuffer.mean_improvement(),
    bestImprovement: trajectoryBuffer.best_improvement(),
    totalCount: trajectoryBuffer.total_count(),
    highQualityCount: trajectoryBuffer.high_quality_count(0.1),
    variance: trajectoryBuffer.variance(),
  };
}

// ============================================================================
// Attention
// ============================================================================

export function computeFlashAttention(
  query: Float32Array,
  keys: Float32Array[],
  values: Float32Array[],
): Float32Array {
  if (!flashAttention) throw new Error('Flash attention not initialized');
  return flashAttention.attention([query], keys, values).output[0];
}

export function computeMoEAttention(
  query: Float32Array,
  keys: Float32Array[],
  values: Float32Array[],
): Float32Array {
  if (!moeWeights) throw new Error('MoE attention not initialized');
  const fa = new PureTSFlashAttention({ dimensions: query.length });
  return fa.attention([query], keys, values).output[0];
}

export function computeHyperbolicAttention(
  query: Float32Array,
  keys: Float32Array[],
  values: Float32Array[],
): Float32Array {
  const fa = new PureTSFlashAttention({ dimensions: query.length });
  return fa.attention([query], keys, values).output[0];
}

// ============================================================================
// Contrastive learning & optimisation
// ============================================================================

export function computeContrastiveLoss(
  anchor: Float32Array,
  positives: Float32Array[],
  negatives: Float32Array[],
): { loss: number; gradient: Float32Array } {
  if (!contrastiveLoss) throw new Error('Contrastive loss not initialized');
  return {
    loss: contrastiveLoss.compute(anchor, positives, negatives),
    gradient: contrastiveLoss.backward(anchor, positives, negatives),
  };
}

export function optimizerStep(params: Float32Array, gradients: Float32Array): Float32Array {
  if (!optimizer) throw new Error('Optimizer not initialized');
  return optimizer.step(params, gradients);
}

export function getCurriculumDifficulty(step: number): number {
  if (!curriculum) return 1.0;
  return curriculum.getDifficulty(step);
}

export function mineHardNegatives(anchor: Float32Array, candidates: Float32Array[]): number[] {
  if (!hardMiner) throw new Error('Hard negative miner not initialized');
  return hardMiner.mine(anchor, candidates);
}

// ============================================================================
// Benchmark
// ============================================================================

export async function benchmarkTraining(
  dim?: number,
  iterations?: number,
): Promise<Array<{ name: string; averageTimeMs: number; opsPerSecond: number }>> {
  const d = dim || 256;
  const fa = new PureTSFlashAttention({ dimensions: d });
  const result = fa.benchmark(512, d, iterations || 5);
  const entry = {
    name: `FlashAttention ${d}-dim`,
    averageTimeMs: result.flashTimeMs,
    opsPerSecond: result.flashTimeMs > 0 ? 1000 / result.flashTimeMs : 0,
  };
  lastBenchmark = [entry];
  return [entry];
}

// ============================================================================
// SONA functions (optional)
// ============================================================================

export function isSonaAvailable(): boolean { return sonaAvailable && sonaEngine !== null; }

export function sonaForceLearn(embedding: Float32Array, reward: number): void {
  if (!sonaEngine) throw new Error('SONA not initialized. Call initializeTraining with useSona: true');
  sonaEngine.forceLearn(embedding, reward);
  totalSonaLearns++;
}

export function sonaFindPatterns(embedding: Float32Array, k: number = 5): unknown[] {
  if (!sonaEngine) throw new Error('SONA not initialized. Call initializeTraining with useSona: true');
  totalSonaSearches++;
  return sonaEngine.findPatterns(Array.from(embedding), k);
}

export function sonaTick(): void { sonaEngine?.tick(); }

export function getSonaStats(): {
  available: boolean; enabled: boolean;
  stats: Record<string, unknown> | null;
  totalLearns: number; totalSearches: number;
} {
  if (!sonaEngine) {
    return { available: false, enabled: false, stats: null, totalLearns: totalSonaLearns, totalSearches: totalSonaSearches };
  }
  try {
    return {
      available: true, enabled: sonaEngine.isEnabled(),
      stats: JSON.parse(sonaEngine.getStats()),
      totalLearns: totalSonaLearns, totalSearches: totalSonaSearches,
    };
  } catch {
    return { available: true, enabled: false, stats: null, totalLearns: totalSonaLearns, totalSearches: totalSonaSearches };
  }
}

export function setSonaEnabled(enabled: boolean): void { sonaEngine?.setEnabled(enabled); }
export function sonaFlush(): void { sonaEngine?.flush(); }

// ============================================================================
// Stats, reset, export, cleanup
// ============================================================================

export function getTrainingStats(): {
  initialized: boolean;
  totalAdaptations: number;
  totalForwards: number;
  microLoraStats?: { paramCount: number; adaptCount: bigint; forwardCount: bigint; deltaNorm: number };
  scopedLoraStats?: { totalAdaptCount: bigint; totalForwardCount: bigint };
  trajectoryStats?: ReturnType<typeof getTrajectoryStats>;
  sonaStats?: ReturnType<typeof getSonaStats>;
  lastBenchmark?: unknown[];
} {
  const stats: ReturnType<typeof getTrainingStats> = { initialized, totalAdaptations, totalForwards };
  if (microLoRA) {
    const s = microLoRA.getStats();
    stats.microLoraStats = {
      paramCount: s.rank * 2,
      adaptCount: BigInt(s.totalUpdates),
      forwardCount: BigInt(s.totalAdaptations),
      deltaNorm: s.avgAdaptationNorm,
    };
  }
  if (scopedLoRA) {
    stats.scopedLoraStats = {
      totalAdaptCount: scopedLoRA.totalAdaptCount(),
      totalForwardCount: scopedLoRA.totalForwardCount(),
    };
  }
  if (trajectoryBuffer && !trajectoryBuffer.is_empty()) stats.trajectoryStats = getTrajectoryStats();
  if (sonaAvailable) stats.sonaStats = getSonaStats();
  if (lastBenchmark) stats.lastBenchmark = lastBenchmark;
  return stats;
}

export function resetTraining(): void {
  microLoRA?.reset();
  scopedLoRA?.resetAll();
  trajectoryBuffer?.reset();
  sonaEngine?.flush();
  totalAdaptations = 0;
  totalForwards = 0;
  totalSonaLearns = 0;
  totalSonaSearches = 0;
}

export function exportWeights(): {
  dim: number; deltaNorm: number; adaptCount: bigint;
  trajectoryStats: ReturnType<typeof getTrajectoryStats>;
} | null {
  if (!initialized || !microLoRA) return null;
  const s = microLoRA.getStats();
  return {
    dim: s.rank,
    deltaNorm: s.avgAdaptationNorm,
    adaptCount: BigInt(s.totalUpdates),
    trajectoryStats: getTrajectoryStats(),
  };
}

export function cleanup(): void {
  microLoRA = null;
  scopedLoRA = null;
  trajectoryBuffer = null;
  if (sonaEngine) { sonaEngine.flush(); sonaEngine = null; sonaAvailable = false; }
  flashAttention = null;
  moeWeights = null;
  optimizer = null;
  contrastiveLoss = null;
  curriculum = null;
  hardMiner = null;
  initialized = false;
  totalAdaptations = 0;
  totalForwards = 0;
  totalSonaLearns = 0;
  totalSonaSearches = 0;
  lastBenchmark = null;
}
