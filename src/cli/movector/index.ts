/**
 * MoVector Integration Module for Claude Flow CLI
 *
 * Provides pure TS vector and neural utilities for:
 * - Q-Learning based task routing
 * - Mixture of Experts (MoE) routing
 * - AST code analysis
 * - Diff classification
 * - Coverage-based routing
 * - Graph boundary analysis
 * - Flash Attention for faster similarity computations
 *
 * @module moflo/movector
 */

export { QLearningRouter, createQLearningRouter, type QLearningRouterConfig, type RouteDecision } from './q-learning-router.js';
export {
  MoERouter,
  getMoERouter,
  resetMoERouter,
  createMoERouter,
  EXPERT_NAMES,
  NUM_EXPERTS,
  INPUT_DIM,
  HIDDEN_DIM,
  type ExpertType,
  type MoERouterConfig,
  type RoutingResult,
  type LoadBalanceStats,
} from './moe-router.js';
export { ASTAnalyzer, createASTAnalyzer, type ASTAnalysis, type ASTNode, type ASTAnalyzerConfig } from './ast-analyzer.js';
export {
  DiffClassifier,
  createDiffClassifier,
  // MCP tool exports
  analyzeDiff,
  analyzeDiffSync,
  assessFileRisk,
  assessOverallRisk,
  classifyDiff,
  suggestReviewers,
  getGitDiffNumstat,
  getGitDiffNumstatAsync,
  // Cache control
  clearDiffCache,
  clearAllDiffCaches,
  // Types
  type DiffClassification,
  type DiffHunk,
  type DiffChange,
  type FileDiff,
  type DiffAnalysis,
  type DiffClassifierConfig,
  type DiffFile,
  type RiskLevel,
  type FileRisk,
  type OverallRisk,
  type DiffAnalysisResult,
} from './diff-classifier.js';
export {
  CoverageRouter,
  createCoverageRouter,
  // MCP tool exports
  coverageRoute,
  coverageSuggest,
  coverageGaps,
  // Cache utilities (NEW)
  clearCoverageCache,
  getCoverageCacheStats,
  // Types
  type CoverageRouterConfig,
  type FileCoverage,
  type CoverageReport,
  type CoverageRouteResult,
  type CoverageSuggestResult,
  type CoverageGapsResult,
  type CoverageRouteOptions,
  type CoverageSuggestOptions,
  type CoverageGapsOptions,
} from './coverage-router.js';
export {
  buildDependencyGraph,
  analyzeGraph,
  analyzeMinCutBoundaries,
  analyzeModuleCommunities,
  detectCircularDependencies,
  exportToDot,
  loadMovector,
  fallbackMinCut,
  fallbackLouvain,
  // Cache utilities (NEW)
  clearGraphCaches,
  getGraphCacheStats,
  type GraphNode,
  type GraphEdge,
  type DependencyGraph,
  type MinCutBoundary,
  type ModuleCommunity,
  type CircularDependency,
  type GraphAnalysisResult,
} from './graph-analyzer.js';
export {
  FlashAttention,
  getFlashAttention,
  resetFlashAttention,
  computeAttention,
  benchmarkFlashAttention,
  getFlashAttentionSpeedup,
  type FlashAttentionConfig,
  type AttentionResult,
  type BenchmarkResult,
} from './flash-attention.js';
export {
  LoRAAdapter,
  getLoRAAdapter,
  resetLoRAAdapter,
  createLoRAAdapter,
  adaptEmbedding,
  trainLoRA,
  getLoRAStats,
  DEFAULT_RANK,
  DEFAULT_ALPHA,
  INPUT_DIM as LORA_INPUT_DIM,
  OUTPUT_DIM as LORA_OUTPUT_DIM,
  type LoRAConfig,
  type LoRAWeights,
  type AdaptationResult,
  type LoRAStats,
} from './lora-adapter.js';
export {
  ModelRouter,
  getModelRouter,
  resetModelRouter,
  createModelRouter,
  routeToModel,
  routeToModelFull,
  analyzeTaskComplexity,
  getModelRouterStats,
  recordModelOutcome,
  MODEL_CAPABILITIES,
  COMPLEXITY_INDICATORS,
  type ClaudeModel,
  type ModelRouterConfig,
  type ModelRoutingResult,
  type ComplexityAnalysis,
} from './model-router.js';
export {
  SemanticRouter,
  createSemanticRouter,
  type Intent,
  type RouteResult,
  type RouterConfig,
} from './semantic-router.js';

/**
 * MoVector availability check (always returns true — all functionality is now pure TS)
 */
export async function isMovectorAvailable(): Promise<boolean> {
  return true;
}

/**
 * Get movector version (returns native implementation version)
 */
export async function getMovectorVersion(): Promise<string | null> {
  return 'native-1.0.0';
}
