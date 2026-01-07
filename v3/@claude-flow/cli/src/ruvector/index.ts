/**
 * RuVector Integration Module for Claude Flow CLI
 *
 * Provides integration with @ruvector packages for:
 * - Q-Learning based task routing
 * - AST code analysis
 * - Diff classification
 * - Coverage-based routing
 * - Graph boundary analysis
 *
 * @module @claude-flow/cli/ruvector
 */

export { QLearningRouter, createQLearningRouter, type QLearningRouterConfig, type RouteDecision } from './q-learning-router.js';
export { ASTAnalyzer, createASTAnalyzer, type ASTAnalysis, type ASTNode, type ASTAnalyzerConfig } from './ast-analyzer.js';
export { DiffClassifier, createDiffClassifier, type DiffClassification, type DiffHunk, type DiffClassifierConfig } from './diff-classifier.js';
export { CoverageRouter, createCoverageRouter, type CoverageReport, type CoverageRouteResult, type CoverageRouterConfig } from './coverage-router.js';
export { GraphAnalyzer, createGraphAnalyzer, type GraphBoundary, type DependencyGraph, type GraphAnalyzerConfig } from './graph-analyzer.js';

/**
 * Check if ruvector packages are available
 */
export async function isRuvectorAvailable(): Promise<boolean> {
  try {
    await import('@ruvector/core');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get ruvector version if available
 */
export async function getRuvectorVersion(): Promise<string | null> {
  try {
    const ruvector = await import('@ruvector/core');
    return (ruvector as any).version || '1.0.0';
  } catch {
    return null;
  }
}
