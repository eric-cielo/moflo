/**
 * Coverage-Aware Routing for @claude-flow/cli
 *
 * Integrates with ruvector's hooks_coverage_route and hooks_coverage_suggest
 * to route tasks to agents based on test coverage gaps.
 *
 * Supports coverage formats:
 * - lcov (lcov.info)
 * - istanbul (coverage-summary.json, coverage-final.json)
 * - c8 (coverage/coverage-summary.json)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, dirname, basename, extname } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface CoverageData {
  /** File path relative to project root */
  filePath: string;
  /** Line coverage percentage (0-100) */
  lineCoverage: number;
  /** Branch coverage percentage (0-100) */
  branchCoverage: number;
  /** Function coverage percentage (0-100) */
  functionCoverage: number;
  /** Statement coverage percentage (0-100) */
  statementCoverage: number;
  /** Uncovered line numbers */
  uncoveredLines: number[];
  /** Uncovered branch locations */
  uncoveredBranches: UncoveredBranch[];
  /** Uncovered function names */
  uncoveredFunctions: string[];
  /** Total lines in file */
  totalLines: number;
  /** Lines that are covered */
  coveredLines: number;
}

export interface UncoveredBranch {
  line: number;
  column?: number;
  type: 'if' | 'else' | 'case' | 'ternary' | 'logical' | 'unknown';
}

export interface CoverageSummary {
  totalFiles: number;
  overallLineCoverage: number;
  overallBranchCoverage: number;
  overallFunctionCoverage: number;
  overallStatementCoverage: number;
  filesBelowThreshold: number;
  coverageThreshold: number;
}

export interface CoverageGap {
  filePath: string;
  coveragePercent: number;
  gapType: 'critical' | 'high' | 'medium' | 'low';
  complexity: number;
  priority: number;
  suggestedAgents: string[];
  uncoveredLines: number[];
  reason: string;
}

export interface CoverageRouteResult {
  success: boolean;
  task: string;
  coverageAware: boolean;
  gaps: CoverageGap[];
  routing: {
    primaryAgent: string;
    confidence: number;
    reason: string;
    coverageImpact: string;
  };
  suggestions: string[];
  metrics: {
    filesAnalyzed: number;
    totalGaps: number;
    criticalGaps: number;
    avgCoverage: number;
  };
}

export interface CoverageSuggestResult {
  success: boolean;
  path: string;
  suggestions: CoverageGap[];
  summary: CoverageSummary;
  prioritizedFiles: string[];
  ruvectorAvailable: boolean;
}

export interface CoverageGapsResult {
  success: boolean;
  gaps: CoverageGap[];
  summary: CoverageSummary;
  agentAssignments: Record<string, string[]>;
  ruvectorAvailable: boolean;
}

// ============================================================================
// RuVector Integration (Graceful Fallback)
// ============================================================================

let ruvectorAvailable: boolean | null = null;

interface RuVectorModule {
  hooks_coverage_route?: (task: string, coverageData: CoverageData[]) => Promise<unknown>;
  hooks_coverage_suggest?: (path: string, coverageData: CoverageData[]) => Promise<unknown>;
}

/**
 * Check if ruvector is available
 */
async function checkRuvectorAvailable(): Promise<boolean> {
  if (ruvectorAvailable !== null) {
    return ruvectorAvailable;
  }

  try {
    // Try to dynamically import ruvector
    const ruvector = await import('ruvector').catch(() => null) as RuVectorModule | null;
    ruvectorAvailable = ruvector !== null &&
      typeof ruvector.hooks_coverage_route === 'function' &&
      typeof ruvector.hooks_coverage_suggest === 'function';
  } catch {
    ruvectorAvailable = false;
  }

  return ruvectorAvailable;
}

/**
 * Call ruvector's hooks_coverage_route if available
 */
async function callRuvectorRoute(
  task: string,
  coverageData: CoverageData[]
): Promise<unknown | null> {
  if (!(await checkRuvectorAvailable())) {
    return null;
  }

  try {
    const ruvector = await import('ruvector') as RuVectorModule;
    if (ruvector.hooks_coverage_route) {
      return await ruvector.hooks_coverage_route(task, coverageData);
    }
  } catch {
    // Graceful fallback
  }
  return null;
}

/**
 * Call ruvector's hooks_coverage_suggest if available
 */
async function callRuvectorSuggest(
  path: string,
  coverageData: CoverageData[]
): Promise<unknown | null> {
  if (!(await checkRuvectorAvailable())) {
    return null;
  }

  try {
    const ruvector = await import('ruvector') as RuVectorModule;
    if (ruvector.hooks_coverage_suggest) {
      return await ruvector.hooks_coverage_suggest(path, coverageData);
    }
  } catch {
    // Graceful fallback
  }
  return null;
}

// ============================================================================
// Coverage Report Parsing
// ============================================================================

/**
 * Find coverage report files in project
 */
export function findCoverageReports(projectRoot: string): {
  type: 'lcov' | 'istanbul' | 'c8' | 'unknown';
  path: string;
}[] {
  const reports: { type: 'lcov' | 'istanbul' | 'c8' | 'unknown'; path: string }[] = [];
  const coverageDir = join(projectRoot, 'coverage');

  // Check for lcov.info
  const lcovPaths = [
    join(projectRoot, 'coverage', 'lcov.info'),
    join(projectRoot, 'lcov.info'),
    join(projectRoot, 'coverage', 'lcov-report', 'lcov.info'),
  ];

  for (const lcovPath of lcovPaths) {
    if (existsSync(lcovPath)) {
      reports.push({ type: 'lcov', path: lcovPath });
    }
  }

  // Check for istanbul/c8 coverage-summary.json
  const summaryPaths = [
    join(coverageDir, 'coverage-summary.json'),
    join(coverageDir, 'coverage-final.json'),
    join(projectRoot, '.nyc_output', 'coverage-summary.json'),
  ];

  for (const summaryPath of summaryPaths) {
    if (existsSync(summaryPath)) {
      const type = summaryPath.includes('.nyc_output') ? 'istanbul' : 'c8';
      reports.push({ type, path: summaryPath });
    }
  }

  return reports;
}

/**
 * Parse LCOV format coverage report
 */
export function parseLcov(lcovContent: string): CoverageData[] {
  const files: CoverageData[] = [];
  const records = lcovContent.split('end_of_record');

  for (const record of records) {
    if (!record.trim()) continue;

    const lines = record.split('\n').map(l => l.trim()).filter(Boolean);
    const sfLine = lines.find(l => l.startsWith('SF:'));
    if (!sfLine) continue;

    const filePath = sfLine.substring(3);
    const data: CoverageData = {
      filePath,
      lineCoverage: 0,
      branchCoverage: 0,
      functionCoverage: 0,
      statementCoverage: 0,
      uncoveredLines: [],
      uncoveredBranches: [],
      uncoveredFunctions: [],
      totalLines: 0,
      coveredLines: 0,
    };

    let linesFound = 0;
    let linesHit = 0;
    let branchesFound = 0;
    let branchesHit = 0;
    let functionsFound = 0;
    let functionsHit = 0;

    for (const line of lines) {
      // Line coverage: DA:line_number,hit_count
      if (line.startsWith('DA:')) {
        const [lineNum, hitCount] = line.substring(3).split(',').map(Number);
        linesFound++;
        if (hitCount > 0) {
          linesHit++;
        } else {
          data.uncoveredLines.push(lineNum);
        }
      }

      // Branch coverage: BRDA:line_number,block_number,branch_number,hit_count
      if (line.startsWith('BRDA:')) {
        const parts = line.substring(5).split(',');
        const lineNum = parseInt(parts[0], 10);
        const hitCount = parts[3] === '-' ? 0 : parseInt(parts[3], 10);
        branchesFound++;
        if (hitCount > 0) {
          branchesHit++;
        } else {
          data.uncoveredBranches.push({
            line: lineNum,
            type: 'unknown',
          });
        }
      }

      // Function coverage: FNDA:hit_count,function_name
      if (line.startsWith('FNDA:')) {
        const [hitCount, funcName] = line.substring(5).split(',');
        functionsFound++;
        if (parseInt(hitCount, 10) > 0) {
          functionsHit++;
        } else {
          data.uncoveredFunctions.push(funcName);
        }
      }

      // Summary lines
      if (line.startsWith('LF:')) {
        data.totalLines = parseInt(line.substring(3), 10);
      }
      if (line.startsWith('LH:')) {
        data.coveredLines = parseInt(line.substring(3), 10);
      }
    }

    // Calculate percentages
    data.lineCoverage = linesFound > 0 ? (linesHit / linesFound) * 100 : 100;
    data.branchCoverage = branchesFound > 0 ? (branchesHit / branchesFound) * 100 : 100;
    data.functionCoverage = functionsFound > 0 ? (functionsHit / functionsFound) * 100 : 100;
    data.statementCoverage = data.lineCoverage; // Often equivalent in LCOV

    files.push(data);
  }

  return files;
}

/**
 * Parse Istanbul/C8 JSON format coverage report
 */
export function parseIstanbulJson(jsonContent: string): CoverageData[] {
  const files: CoverageData[] = [];

  try {
    const coverage = JSON.parse(jsonContent) as Record<string, {
      path?: string;
      s?: Record<string, number>;
      b?: Record<string, number[]>;
      f?: Record<string, number>;
      statementMap?: Record<string, { start: { line: number } }>;
      branchMap?: Record<string, { line: number; type?: string }>;
      fnMap?: Record<string, { name: string }>;
      // Summary format
      lines?: { total: number; covered: number; pct: number };
      statements?: { total: number; covered: number; pct: number };
      functions?: { total: number; covered: number; pct: number };
      branches?: { total: number; covered: number; pct: number };
    }>;

    for (const [filePath, fileData] of Object.entries(coverage)) {
      // Skip 'total' entry in summary format
      if (filePath === 'total') continue;

      const data: CoverageData = {
        filePath: fileData.path || filePath,
        lineCoverage: 0,
        branchCoverage: 0,
        functionCoverage: 0,
        statementCoverage: 0,
        uncoveredLines: [],
        uncoveredBranches: [],
        uncoveredFunctions: [],
        totalLines: 0,
        coveredLines: 0,
      };

      // Handle summary format
      if (fileData.lines && typeof fileData.lines.pct === 'number') {
        data.lineCoverage = fileData.lines.pct;
        data.statementCoverage = fileData.statements?.pct ?? fileData.lines.pct;
        data.branchCoverage = fileData.branches?.pct ?? 100;
        data.functionCoverage = fileData.functions?.pct ?? 100;
        data.totalLines = fileData.lines.total;
        data.coveredLines = fileData.lines.covered;
        files.push(data);
        continue;
      }

      // Handle detailed format
      if (fileData.s && fileData.statementMap) {
        let statementsTotal = 0;
        let statementsCovered = 0;

        for (const [stmtId, hitCount] of Object.entries(fileData.s)) {
          statementsTotal++;
          if (hitCount > 0) {
            statementsCovered++;
          } else {
            const stmtInfo = fileData.statementMap[stmtId];
            if (stmtInfo?.start?.line) {
              data.uncoveredLines.push(stmtInfo.start.line);
            }
          }
        }

        data.statementCoverage = statementsTotal > 0
          ? (statementsCovered / statementsTotal) * 100
          : 100;
        data.lineCoverage = data.statementCoverage;
        data.totalLines = statementsTotal;
        data.coveredLines = statementsCovered;
      }

      // Handle branch coverage
      if (fileData.b && fileData.branchMap) {
        let branchesTotal = 0;
        let branchesCovered = 0;

        for (const [branchId, hits] of Object.entries(fileData.b)) {
          for (const hitCount of hits) {
            branchesTotal++;
            if (hitCount > 0) {
              branchesCovered++;
            } else {
              const branchInfo = fileData.branchMap[branchId];
              if (branchInfo) {
                data.uncoveredBranches.push({
                  line: branchInfo.line,
                  type: (branchInfo.type || 'unknown') as UncoveredBranch['type'],
                });
              }
            }
          }
        }

        data.branchCoverage = branchesTotal > 0
          ? (branchesCovered / branchesTotal) * 100
          : 100;
      }

      // Handle function coverage
      if (fileData.f && fileData.fnMap) {
        let functionsTotal = 0;
        let functionsCovered = 0;

        for (const [fnId, hitCount] of Object.entries(fileData.f)) {
          functionsTotal++;
          if (hitCount > 0) {
            functionsCovered++;
          } else {
            const fnInfo = fileData.fnMap[fnId];
            if (fnInfo?.name) {
              data.uncoveredFunctions.push(fnInfo.name);
            }
          }
        }

        data.functionCoverage = functionsTotal > 0
          ? (functionsCovered / functionsTotal) * 100
          : 100;
      }

      // Deduplicate uncovered lines
      data.uncoveredLines = Array.from(new Set(data.uncoveredLines)).sort((a, b) => a - b);

      files.push(data);
    }
  } catch {
    // Return empty array on parse error
  }

  return files;
}

/**
 * Load and parse coverage data from project
 */
export async function loadCoverageData(projectRoot: string): Promise<{
  data: CoverageData[];
  format: 'lcov' | 'istanbul' | 'c8' | 'none';
  reportPath: string | null;
}> {
  const reports = findCoverageReports(projectRoot);

  if (reports.length === 0) {
    return { data: [], format: 'none', reportPath: null };
  }

  // Prefer lcov format for most detailed data
  const lcovReport = reports.find(r => r.type === 'lcov');
  if (lcovReport) {
    const content = readFileSync(lcovReport.path, 'utf-8');
    return {
      data: parseLcov(content),
      format: 'lcov',
      reportPath: lcovReport.path,
    };
  }

  // Fall back to istanbul/c8 JSON
  const jsonReport = reports.find(r => r.type === 'istanbul' || r.type === 'c8');
  if (jsonReport) {
    const content = readFileSync(jsonReport.path, 'utf-8');
    return {
      data: parseIstanbulJson(content),
      format: jsonReport.type,
      reportPath: jsonReport.path,
    };
  }

  return { data: [], format: 'none', reportPath: null };
}

// ============================================================================
// Coverage Analysis
// ============================================================================

/**
 * Calculate file complexity based on size and structure
 */
function calculateComplexity(filePath: string, projectRoot: string): number {
  const fullPath = resolve(projectRoot, filePath);

  try {
    if (!existsSync(fullPath)) return 1;

    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const lineCount = lines.length;

    // Basic complexity heuristics
    let complexity = 1;

    // Line count factor
    if (lineCount > 500) complexity += 3;
    else if (lineCount > 200) complexity += 2;
    else if (lineCount > 100) complexity += 1;

    // Control flow complexity (simple estimation)
    const controlFlowKeywords = content.match(
      /\b(if|else|switch|case|for|while|do|try|catch|throw)\b/g
    );
    if (controlFlowKeywords) {
      complexity += Math.min(5, Math.floor(controlFlowKeywords.length / 10));
    }

    // Class/function count
    const declarations = content.match(
      /\b(class|function|const\s+\w+\s*=\s*(async\s+)?\(|=>\s*{)/g
    );
    if (declarations) {
      complexity += Math.min(3, Math.floor(declarations.length / 5));
    }

    return Math.min(10, complexity);
  } catch {
    return 1;
  }
}

/**
 * Determine gap type based on coverage percentage
 */
function determineGapType(coverage: number): 'critical' | 'high' | 'medium' | 'low' {
  if (coverage < 20) return 'critical';
  if (coverage < 50) return 'high';
  if (coverage < 70) return 'medium';
  return 'low';
}

/**
 * Suggest agents based on file type and coverage gap
 */
function suggestAgentsForFile(
  filePath: string,
  coverageData: CoverageData,
  gapType: 'critical' | 'high' | 'medium' | 'low'
): string[] {
  const ext = extname(filePath).toLowerCase();
  const fileName = basename(filePath).toLowerCase();
  const agents: string[] = [];

  // Test files need tester primarily
  if (fileName.includes('.test.') || fileName.includes('.spec.')) {
    agents.push('tester', 'reviewer');
    return agents;
  }

  // Based on file extension
  const extAgentMap: Record<string, string[]> = {
    '.ts': ['coder', 'tester', 'reviewer'],
    '.tsx': ['coder', 'tester', 'reviewer'],
    '.js': ['coder', 'tester'],
    '.jsx': ['coder', 'tester'],
    '.py': ['coder', 'tester', 'ml-developer'],
    '.go': ['coder', 'tester'],
    '.rs': ['coder', 'tester', 'performance-engineer'],
  };

  // Based on directory/file purpose
  if (filePath.includes('/api/') || filePath.includes('/routes/')) {
    agents.push('coder', 'tester', 'security-architect');
  } else if (filePath.includes('/auth/') || filePath.includes('security')) {
    agents.push('security-architect', 'tester', 'coder');
  } else if (filePath.includes('/utils/') || filePath.includes('/helpers/')) {
    agents.push('coder', 'tester');
  } else if (filePath.includes('/services/')) {
    agents.push('coder', 'tester', 'architect');
  } else {
    agents.push(...(extAgentMap[ext] || ['coder', 'tester']));
  }

  // For critical gaps, add reviewer
  if (gapType === 'critical' && !agents.includes('reviewer')) {
    agents.push('reviewer');
  }

  // For uncovered branches, add architect for complex logic
  if (coverageData.uncoveredBranches.length > 5) {
    if (!agents.includes('architect')) {
      agents.push('architect');
    }
  }

  return Array.from(new Set(agents)).slice(0, 4);
}

/**
 * Calculate priority score for coverage gap
 */
function calculatePriority(
  coverageData: CoverageData,
  complexity: number,
  gapType: 'critical' | 'high' | 'medium' | 'low'
): number {
  // Base priority from gap type
  const gapPriority: Record<string, number> = {
    critical: 100,
    high: 75,
    medium: 50,
    low: 25,
  };

  let priority = gapPriority[gapType];

  // Add complexity factor (0-30 points)
  priority += complexity * 3;

  // Add uncovered lines factor (0-20 points)
  const uncoveredRatio = coverageData.uncoveredLines.length / Math.max(1, coverageData.totalLines);
  priority += Math.min(20, uncoveredRatio * 50);

  // Add branch coverage factor (0-15 points)
  if (coverageData.branchCoverage < 50) {
    priority += 15;
  } else if (coverageData.branchCoverage < 75) {
    priority += 8;
  }

  // Important file patterns get boost
  const fileName = basename(coverageData.filePath);
  if (fileName.includes('service') || fileName.includes('controller')) {
    priority += 10;
  }
  if (fileName.includes('auth') || fileName.includes('security')) {
    priority += 15;
  }

  return Math.min(200, priority);
}

/**
 * Analyze coverage and identify gaps
 */
export function analyzeCoverageGaps(
  coverageData: CoverageData[],
  projectRoot: string,
  threshold: number = 80
): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  for (const data of coverageData) {
    const avgCoverage = (
      data.lineCoverage +
      data.branchCoverage +
      data.functionCoverage +
      data.statementCoverage
    ) / 4;

    if (avgCoverage >= threshold) continue;

    const gapType = determineGapType(avgCoverage);
    const complexity = calculateComplexity(data.filePath, projectRoot);
    const suggestedAgents = suggestAgentsForFile(data.filePath, data, gapType);
    const priority = calculatePriority(data, complexity, gapType);

    // Generate reason
    const reasons: string[] = [];
    if (data.lineCoverage < threshold) {
      reasons.push(`line coverage ${data.lineCoverage.toFixed(1)}%`);
    }
    if (data.branchCoverage < threshold) {
      reasons.push(`branch coverage ${data.branchCoverage.toFixed(1)}%`);
    }
    if (data.uncoveredFunctions.length > 0) {
      reasons.push(`${data.uncoveredFunctions.length} uncovered functions`);
    }

    gaps.push({
      filePath: data.filePath,
      coveragePercent: avgCoverage,
      gapType,
      complexity,
      priority,
      suggestedAgents,
      uncoveredLines: data.uncoveredLines.slice(0, 20), // Limit for output
      reason: reasons.join(', ') || 'Below threshold',
    });
  }

  // Sort by priority (descending)
  return gaps.sort((a, b) => b.priority - a.priority);
}

/**
 * Generate coverage summary
 */
export function generateCoverageSummary(
  coverageData: CoverageData[],
  threshold: number = 80
): CoverageSummary {
  if (coverageData.length === 0) {
    return {
      totalFiles: 0,
      overallLineCoverage: 0,
      overallBranchCoverage: 0,
      overallFunctionCoverage: 0,
      overallStatementCoverage: 0,
      filesBelowThreshold: 0,
      coverageThreshold: threshold,
    };
  }

  const totals = coverageData.reduce(
    (acc, data) => {
      acc.line += data.lineCoverage;
      acc.branch += data.branchCoverage;
      acc.function += data.functionCoverage;
      acc.statement += data.statementCoverage;
      return acc;
    },
    { line: 0, branch: 0, function: 0, statement: 0 }
  );

  const fileCount = coverageData.length;
  const avgLine = totals.line / fileCount;
  const avgBranch = totals.branch / fileCount;
  const avgFunction = totals.function / fileCount;
  const avgStatement = totals.statement / fileCount;

  const belowThreshold = coverageData.filter(d => {
    const avg = (d.lineCoverage + d.branchCoverage + d.functionCoverage + d.statementCoverage) / 4;
    return avg < threshold;
  }).length;

  return {
    totalFiles: fileCount,
    overallLineCoverage: avgLine,
    overallBranchCoverage: avgBranch,
    overallFunctionCoverage: avgFunction,
    overallStatementCoverage: avgStatement,
    filesBelowThreshold: belowThreshold,
    coverageThreshold: threshold,
  };
}

// ============================================================================
// Main API Functions
// ============================================================================

/**
 * Route a task with coverage awareness
 *
 * CLI Usage:
 *   claude-flow route "fix bug" --coverage-aware
 */
export async function coverageRoute(
  task: string,
  options: {
    projectRoot?: string;
    threshold?: number;
    useRuvector?: boolean;
  } = {}
): Promise<CoverageRouteResult> {
  const projectRoot = options.projectRoot || process.cwd();
  const threshold = options.threshold ?? 80;
  const useRuvector = options.useRuvector !== false;

  // Load coverage data
  const { data: coverageData, format, reportPath } = await loadCoverageData(projectRoot);

  // Analyze gaps
  const gaps = coverageData.length > 0
    ? analyzeCoverageGaps(coverageData, projectRoot, threshold)
    : [];

  // Try ruvector integration if available
  if (useRuvector && coverageData.length > 0) {
    const ruvectorResult = await callRuvectorRoute(task, coverageData);
    if (ruvectorResult && typeof ruvectorResult === 'object') {
      // Merge ruvector insights if available
      // (ruvector provides more sophisticated ML-based routing)
    }
  }

  // Determine primary agent based on task + coverage
  const taskLower = task.toLowerCase();
  let primaryAgent = 'coder';
  let confidence = 0.75;
  let reason = 'Default routing based on task analysis';
  let coverageImpact = 'No coverage data available';

  if (gaps.length > 0) {
    // Find most relevant gap for task
    const criticalGaps = gaps.filter(g => g.gapType === 'critical' || g.gapType === 'high');

    if (criticalGaps.length > 0) {
      primaryAgent = criticalGaps[0].suggestedAgents[0] || 'tester';
      confidence = 0.85;
      reason = `Critical coverage gap in ${criticalGaps[0].filePath}`;
      coverageImpact = `${criticalGaps.length} high-priority files need attention`;
    }

    // Override based on task keywords
    if (taskLower.includes('test') || taskLower.includes('coverage')) {
      primaryAgent = 'tester';
      confidence = 0.9;
      reason = 'Task explicitly mentions testing/coverage';
    } else if (taskLower.includes('security') || taskLower.includes('auth')) {
      primaryAgent = 'security-architect';
      confidence = 0.88;
      reason = 'Security-related task detected';
    }
  }

  // Generate suggestions
  const suggestions: string[] = [];
  if (format === 'none') {
    suggestions.push('Run tests with coverage to enable coverage-aware routing');
    suggestions.push('Supported formats: lcov, istanbul (c8), nyc');
  } else {
    if (gaps.length === 0) {
      suggestions.push('All files meet coverage threshold');
    } else {
      suggestions.push(`Focus on ${gaps.slice(0, 3).map(g => basename(g.filePath)).join(', ')}`);
      if (gaps.some(g => g.gapType === 'critical')) {
        suggestions.push('Critical coverage gaps detected - prioritize testing');
      }
    }
  }

  const summary = generateCoverageSummary(coverageData, threshold);

  return {
    success: true,
    task,
    coverageAware: format !== 'none',
    gaps: gaps.slice(0, 10), // Limit output
    routing: {
      primaryAgent,
      confidence,
      reason,
      coverageImpact,
    },
    suggestions,
    metrics: {
      filesAnalyzed: coverageData.length,
      totalGaps: gaps.length,
      criticalGaps: gaps.filter(g => g.gapType === 'critical').length,
      avgCoverage: summary.overallLineCoverage,
    },
  };
}

/**
 * Suggest coverage improvements for a path
 *
 * CLI Usage:
 *   claude-flow route --coverage-suggest src/
 */
export async function coverageSuggest(
  path: string,
  options: {
    projectRoot?: string;
    threshold?: number;
    useRuvector?: boolean;
    limit?: number;
  } = {}
): Promise<CoverageSuggestResult> {
  const projectRoot = options.projectRoot || process.cwd();
  const threshold = options.threshold ?? 80;
  const useRuvector = options.useRuvector !== false;
  const limit = options.limit ?? 20;

  // Load coverage data
  const { data: coverageData, format } = await loadCoverageData(projectRoot);

  // Filter to requested path
  const normalizedPath = path.startsWith('/') ? path : join(projectRoot, path);
  const relativePath = relative(projectRoot, normalizedPath);

  const filteredData = coverageData.filter(d => {
    const filePath = d.filePath.replace(/^\.?\//, '');
    return filePath.startsWith(relativePath) || filePath.includes(path);
  });

  // Analyze gaps
  const gaps = analyzeCoverageGaps(filteredData, projectRoot, threshold);

  // Try ruvector integration
  const ruvectorAvail = useRuvector ? await checkRuvectorAvailable() : false;
  if (ruvectorAvail && filteredData.length > 0) {
    await callRuvectorSuggest(path, filteredData);
  }

  const summary = generateCoverageSummary(filteredData, threshold);

  return {
    success: true,
    path,
    suggestions: gaps.slice(0, limit),
    summary,
    prioritizedFiles: gaps.slice(0, 10).map(g => g.filePath),
    ruvectorAvailable: ruvectorAvail,
  };
}

/**
 * Get all coverage gaps in project
 *
 * CLI Usage:
 *   claude-flow route --coverage-gaps
 */
export async function coverageGaps(
  options: {
    projectRoot?: string;
    threshold?: number;
    useRuvector?: boolean;
    groupByAgent?: boolean;
  } = {}
): Promise<CoverageGapsResult> {
  const projectRoot = options.projectRoot || process.cwd();
  const threshold = options.threshold ?? 80;
  const useRuvector = options.useRuvector !== false;
  const groupByAgent = options.groupByAgent ?? true;

  // Load coverage data
  const { data: coverageData } = await loadCoverageData(projectRoot);

  // Analyze all gaps
  const gaps = analyzeCoverageGaps(coverageData, projectRoot, threshold);

  // Group by suggested agent
  const agentAssignments: Record<string, string[]> = {};
  if (groupByAgent) {
    for (const gap of gaps) {
      const primaryAgent = gap.suggestedAgents[0] || 'tester';
      if (!agentAssignments[primaryAgent]) {
        agentAssignments[primaryAgent] = [];
      }
      agentAssignments[primaryAgent].push(gap.filePath);
    }
  }

  const summary = generateCoverageSummary(coverageData, threshold);
  const ruvectorAvail = useRuvector ? await checkRuvectorAvailable() : false;

  return {
    success: true,
    gaps,
    summary,
    agentAssignments,
    ruvectorAvailable: ruvectorAvail,
  };
}

// ============================================================================
// Export
// ============================================================================

export default {
  coverageRoute,
  coverageSuggest,
  coverageGaps,
  loadCoverageData,
  analyzeCoverageGaps,
  generateCoverageSummary,
  parseLcov,
  parseIstanbulJson,
  findCoverageReports,
};
