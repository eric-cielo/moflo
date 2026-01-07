/**
 * Diff Classification Module
 * Analyzes git diffs for change risk assessment and classification
 *
 * Uses ruvector's hooks_diff_analyze and hooks_diff_classify when available,
 * with graceful fallback to built-in analysis.
 */

import { execSync, spawnSync } from 'child_process';

// ============================================
// Types
// ============================================

export type RiskLevel = 'low-risk' | 'medium-risk' | 'high-risk' | 'critical';

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: number;
  binary: boolean;
  oldPath?: string; // For renamed files
}

export interface DiffRiskAssessment {
  overall: RiskLevel;
  score: number; // 0-100
  breakdown: {
    fileCount: number;
    totalChanges: number;
    highRiskFiles: string[];
    securityConcerns: string[];
    breakingChanges: string[];
    testCoverage: 'adequate' | 'insufficient' | 'unknown';
  };
}

export interface DiffClassification {
  category: string;
  subcategory?: string;
  confidence: number;
  reasoning: string;
}

export interface FileRisk {
  path: string;
  risk: RiskLevel;
  score: number;
  reasons: string[];
}

export interface DiffAnalysisResult {
  ref: string;
  timestamp: string;
  files: DiffFile[];
  risk: DiffRiskAssessment;
  classification: DiffClassification;
  fileRisks: FileRisk[];
  recommendedReviewers: string[];
  summary: string;
}

// ============================================
// Risk Patterns
// ============================================

const HIGH_RISK_PATTERNS = [
  { pattern: /auth|authentication|login|password|secret|token|key|credential/i, reason: 'Security-sensitive code' },
  { pattern: /payment|billing|checkout|stripe|paypal|transaction/i, reason: 'Payment processing code' },
  { pattern: /database|migration|schema|sql|query/i, reason: 'Database changes' },
  { pattern: /security|permission|access|rbac|acl/i, reason: 'Security/permission changes' },
  { pattern: /config|\.env|environment/i, reason: 'Configuration changes' },
  { pattern: /api\/v\d|breaking|deprecat/i, reason: 'Potential API breaking changes' },
  { pattern: /crypto|encrypt|decrypt|hash/i, reason: 'Cryptography code' },
];

const MEDIUM_RISK_PATTERNS = [
  { pattern: /core|base|foundation|lib\//i, reason: 'Core library changes' },
  { pattern: /interface|type|contract/i, reason: 'Interface/contract changes' },
  { pattern: /package\.json|yarn\.lock|package-lock/i, reason: 'Dependency changes' },
  { pattern: /ci|cd|workflow|pipeline|\.github/i, reason: 'CI/CD changes' },
  { pattern: /docker|kubernetes|k8s|helm/i, reason: 'Infrastructure changes' },
];

const SAFE_PATTERNS = [
  { pattern: /\.md$|readme|docs\//i, reason: 'Documentation' },
  { pattern: /\.test\.|\.spec\.|__tests__/i, reason: 'Test files' },
  { pattern: /\.snap$|snapshot/i, reason: 'Snapshot files' },
  { pattern: /\.css$|\.scss$|\.less$|\.styl/i, reason: 'Style files' },
  { pattern: /comments?|todo|fixme/i, reason: 'Comment changes' },
];

// File extension to reviewer mapping
const REVIEWER_PATTERNS: Record<string, string[]> = {
  '.ts': ['typescript-expert', 'coder'],
  '.tsx': ['frontend-expert', 'coder', 'reviewer'],
  '.py': ['python-expert', 'coder'],
  '.go': ['go-expert', 'coder'],
  '.rs': ['rust-expert', 'coder'],
  '.sql': ['database-expert', 'architect'],
  '.sh': ['devops-expert', 'security-expert'],
  '.dockerfile': ['devops-expert', 'security-expert'],
  '.yaml': ['devops-expert', 'architect'],
  '.yml': ['devops-expert', 'architect'],
  '.json': ['coder', 'architect'],
  'security': ['security-expert', 'architect'],
  'auth': ['security-expert', 'architect'],
  'payment': ['security-expert', 'senior-reviewer'],
};

// ============================================
// RuVector Integration (Graceful Fallback)
// ============================================

interface RuVectorResult {
  available: boolean;
  analysis?: unknown;
  classification?: unknown;
}

/**
 * Attempts to use ruvector's diff analysis when available
 */
async function tryRuVectorAnalysis(diffContent: string): Promise<RuVectorResult> {
  try {
    // Check if ruvector is available
    const result = spawnSync('npx', ['ruvector', '--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (result.status !== 0) {
      return { available: false };
    }

    // Try hooks_diff_analyze
    const analyzeResult = spawnSync('npx', ['ruvector', 'hooks_diff_analyze'], {
      input: diffContent,
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (analyzeResult.status === 0 && analyzeResult.stdout) {
      try {
        const analysis = JSON.parse(analyzeResult.stdout);
        return { available: true, analysis };
      } catch {
        // JSON parse failed, continue with fallback
      }
    }

    return { available: false };
  } catch {
    return { available: false };
  }
}

/**
 * Attempts to use ruvector's diff classification when available
 */
async function tryRuVectorClassify(diffContent: string): Promise<RuVectorResult> {
  try {
    const result = spawnSync('npx', ['ruvector', 'hooks_diff_classify'], {
      input: diffContent,
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.status === 0 && result.stdout) {
      try {
        const classification = JSON.parse(result.stdout);
        return { available: true, classification };
      } catch {
        // JSON parse failed, continue with fallback
      }
    }

    return { available: false };
  } catch {
    return { available: false };
  }
}

// ============================================
// Git Diff Parsing
// ============================================

/**
 * Get git diff for a given ref
 */
export function getGitDiff(ref: string = 'HEAD~1', cwd?: string): string {
  try {
    const result = execSync(`git diff ${ref}`, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return result;
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get git diff --stat for file summary
 */
export function getGitDiffStat(ref: string = 'HEAD~1', cwd?: string): string {
  try {
    const result = execSync(`git diff --stat ${ref}`, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
    });
    return result;
  } catch (error) {
    throw new Error(`Failed to get git diff stat: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get git diff --numstat for precise line counts
 */
export function getGitDiffNumstat(ref: string = 'HEAD~1', cwd?: string): DiffFile[] {
  try {
    const numstat = execSync(`git diff --numstat ${ref}`, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
    });

    const nameStatus = execSync(`git diff --name-status ${ref}`, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
    });

    const files: DiffFile[] = [];
    const numstatLines = numstat.trim().split('\n').filter(Boolean);
    const statusMap = new Map<string, string>();

    // Parse name-status output
    nameStatus.trim().split('\n').filter(Boolean).forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const status = parts[0];
        const path = parts.length === 3 ? parts[2] : parts[1]; // Handle renames
        statusMap.set(path, status);
      }
    });

    for (const line of numstatLines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        const path = parts[2];
        const binary = parts[0] === '-' && parts[1] === '-';

        const statusCode = statusMap.get(path) || 'M';
        let status: DiffFile['status'] = 'modified';
        let oldPath: string | undefined;

        if (statusCode.startsWith('A')) status = 'added';
        else if (statusCode.startsWith('D')) status = 'deleted';
        else if (statusCode.startsWith('R')) {
          status = 'renamed';
          // For renames, the old path is in the numstat
        }

        files.push({
          path,
          status,
          additions,
          deletions,
          hunks: 1, // Approximate
          binary,
          oldPath,
        });
      }
    }

    return files;
  } catch (error) {
    throw new Error(`Failed to get git diff numstat: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get file contributors for reviewer suggestions
 */
export function getFileContributors(filePath: string, cwd?: string): string[] {
  try {
    const result = execSync(
      `git log --format='%an' --follow -- "${filePath}" | sort | uniq -c | sort -rn | head -5`,
      {
        cwd: cwd || process.cwd(),
        encoding: 'utf-8',
        shell: '/bin/bash',
      }
    );

    return result
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => line.trim().replace(/^\d+\s+/, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================
// Risk Assessment
// ============================================

/**
 * Calculate risk score for a single file
 */
export function assessFileRisk(file: DiffFile): FileRisk {
  const reasons: string[] = [];
  let score = 0;

  // Base score from change size
  const totalChanges = file.additions + file.deletions;
  if (totalChanges > 500) {
    score += 30;
    reasons.push(`Large change (${totalChanges} lines)`);
  } else if (totalChanges > 200) {
    score += 20;
    reasons.push(`Significant change (${totalChanges} lines)`);
  } else if (totalChanges > 50) {
    score += 10;
  }

  // Check high-risk patterns
  for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(file.path)) {
      score += 25;
      reasons.push(reason);
    }
  }

  // Check medium-risk patterns
  for (const { pattern, reason } of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(file.path)) {
      score += 15;
      reasons.push(reason);
    }
  }

  // Reduce score for safe patterns
  for (const { pattern, reason } of SAFE_PATTERNS) {
    if (pattern.test(file.path)) {
      score = Math.max(0, score - 20);
      reasons.push(`${reason} (lower risk)`);
    }
  }

  // Deleted files are higher risk
  if (file.status === 'deleted') {
    score += 15;
    reasons.push('File deletion');
  }

  // Binary files need careful review
  if (file.binary) {
    score += 10;
    reasons.push('Binary file');
  }

  // Cap score at 100
  score = Math.min(100, score);

  // Determine risk level
  let risk: RiskLevel = 'low-risk';
  if (score >= 70) risk = 'critical';
  else if (score >= 50) risk = 'high-risk';
  else if (score >= 25) risk = 'medium-risk';

  return { path: file.path, risk, score, reasons };
}

/**
 * Calculate overall risk assessment for all files
 */
export function assessOverallRisk(files: DiffFile[], fileRisks: FileRisk[]): DiffRiskAssessment {
  const totalChanges = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const highRiskFiles = fileRisks.filter(f => f.risk === 'high-risk' || f.risk === 'critical').map(f => f.path);

  // Security concerns
  const securityConcerns: string[] = [];
  for (const file of files) {
    if (/auth|password|secret|token|key|credential|crypto/i.test(file.path)) {
      securityConcerns.push(`Security-sensitive file: ${file.path}`);
    }
  }

  // Breaking changes detection
  const breakingChanges: string[] = [];
  for (const file of files) {
    if (/api\/v\d|breaking|deprecat|interface|type/i.test(file.path)) {
      if (file.deletions > file.additions) {
        breakingChanges.push(`Potential breaking change: ${file.path}`);
      }
    }
  }

  // Test coverage assessment
  const testFiles = files.filter(f => /\.test\.|\.spec\.|__tests__/i.test(f.path));
  const sourceFiles = files.filter(f => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f.path) && !/\.test\.|\.spec\./i.test(f.path));
  let testCoverage: 'adequate' | 'insufficient' | 'unknown' = 'unknown';
  if (sourceFiles.length > 0) {
    testCoverage = testFiles.length >= sourceFiles.length * 0.5 ? 'adequate' : 'insufficient';
  }

  // Calculate overall score (weighted average)
  const avgScore = fileRisks.length > 0
    ? fileRisks.reduce((sum, f) => sum + f.score, 0) / fileRisks.length
    : 0;

  // Adjust for file count
  let score = avgScore;
  if (files.length > 20) score += 15;
  else if (files.length > 10) score += 10;
  else if (files.length > 5) score += 5;

  // Adjust for security concerns
  score += securityConcerns.length * 10;
  score += breakingChanges.length * 10;

  // Cap at 100
  score = Math.min(100, Math.round(score));

  // Determine overall risk level
  let overall: RiskLevel = 'low-risk';
  if (score >= 70) overall = 'critical';
  else if (score >= 50) overall = 'high-risk';
  else if (score >= 25) overall = 'medium-risk';

  return {
    overall,
    score,
    breakdown: {
      fileCount: files.length,
      totalChanges,
      highRiskFiles,
      securityConcerns,
      breakingChanges,
      testCoverage,
    },
  };
}

// ============================================
// Classification
// ============================================

/**
 * Classify the type of change
 */
export function classifyDiff(files: DiffFile[]): DiffClassification {
  // Count by category
  const categories = {
    feature: 0,
    bugfix: 0,
    refactor: 0,
    test: 0,
    docs: 0,
    config: 0,
    style: 0,
    infra: 0,
    security: 0,
  };

  for (const file of files) {
    const path = file.path.toLowerCase();

    if (/\.test\.|\.spec\.|__tests__/.test(path)) categories.test++;
    else if (/\.md$|readme|docs\//.test(path)) categories.docs++;
    else if (/\.css$|\.scss$|\.less$|\.styl/.test(path)) categories.style++;
    else if (/config|\.env|\.yaml|\.yml|\.json$/.test(path)) categories.config++;
    else if (/docker|kubernetes|k8s|helm|ci|cd|workflow/.test(path)) categories.infra++;
    else if (/auth|security|permission|crypto/.test(path)) categories.security++;
    else if (file.deletions > file.additions * 2) categories.refactor++;
    else if (file.status === 'added') categories.feature++;
    else categories.bugfix++;
  }

  // Find dominant category
  let maxCount = 0;
  let category = 'feature';
  for (const [cat, count] of Object.entries(categories)) {
    if (count > maxCount) {
      maxCount = count;
      category = cat;
    }
  }

  // Calculate confidence
  const total = Object.values(categories).reduce((a, b) => a + b, 0);
  const confidence = total > 0 ? Math.min(0.95, (maxCount / total) + 0.2) : 0.5;

  // Generate reasoning
  const reasoning = generateClassificationReasoning(category, files, categories);

  return {
    category,
    subcategory: getSubcategory(category, files),
    confidence,
    reasoning,
  };
}

function getSubcategory(category: string, files: DiffFile[]): string | undefined {
  const paths = files.map(f => f.path.toLowerCase()).join(' ');

  switch (category) {
    case 'feature':
      if (/api/.test(paths)) return 'api';
      if (/ui|component|page/.test(paths)) return 'frontend';
      if (/model|database/.test(paths)) return 'backend';
      break;
    case 'bugfix':
      if (/security|auth/.test(paths)) return 'security-fix';
      if (/performance|perf/.test(paths)) return 'performance-fix';
      break;
    case 'infra':
      if (/docker/.test(paths)) return 'containerization';
      if (/ci|cd|workflow/.test(paths)) return 'ci-cd';
      if (/kubernetes|k8s/.test(paths)) return 'kubernetes';
      break;
  }

  return undefined;
}

function generateClassificationReasoning(
  category: string,
  files: DiffFile[],
  categories: Record<string, number>
): string {
  const total = files.length;
  const parts: string[] = [];

  parts.push(`${total} file(s) changed.`);

  if (categories.test > 0) {
    parts.push(`${categories.test} test file(s).`);
  }

  if (categories.docs > 0) {
    parts.push(`${categories.docs} documentation file(s).`);
  }

  const addedCount = files.filter(f => f.status === 'added').length;
  const deletedCount = files.filter(f => f.status === 'deleted').length;

  if (addedCount > 0) {
    parts.push(`${addedCount} new file(s) added.`);
  }

  if (deletedCount > 0) {
    parts.push(`${deletedCount} file(s) deleted.`);
  }

  parts.push(`Classified as ${category} based on change patterns.`);

  return parts.join(' ');
}

// ============================================
// Reviewer Recommendations
// ============================================

/**
 * Suggest reviewers based on files changed and their history
 */
export function suggestReviewers(files: DiffFile[], fileRisks: FileRisk[]): string[] {
  const reviewerScores = new Map<string, number>();

  for (const file of files) {
    const ext = file.path.match(/\.[a-zA-Z0-9]+$/)?.[0] || '';
    const pathLower = file.path.toLowerCase();

    // Add reviewers based on file extension
    const extReviewers = REVIEWER_PATTERNS[ext] || [];
    for (const reviewer of extReviewers) {
      reviewerScores.set(reviewer, (reviewerScores.get(reviewer) || 0) + 1);
    }

    // Add reviewers based on path patterns
    for (const [pattern, reviewers] of Object.entries(REVIEWER_PATTERNS)) {
      if (pathLower.includes(pattern)) {
        for (const reviewer of reviewers) {
          reviewerScores.set(reviewer, (reviewerScores.get(reviewer) || 0) + 2);
        }
      }
    }
  }

  // Boost scores for high-risk files
  for (const risk of fileRisks.filter(f => f.risk === 'high-risk' || f.risk === 'critical')) {
    reviewerScores.set('senior-reviewer', (reviewerScores.get('senior-reviewer') || 0) + 3);
    if (risk.reasons.some(r => /security/i.test(r))) {
      reviewerScores.set('security-expert', (reviewerScores.get('security-expert') || 0) + 3);
    }
  }

  // Sort by score and return top reviewers
  return Array.from(reviewerScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reviewer]) => reviewer);
}

// ============================================
// Main Analysis Function
// ============================================

export interface AnalyzeOptions {
  ref?: string;
  cwd?: string;
  useRuVector?: boolean;
}

/**
 * Perform complete diff analysis
 */
export async function analyzeDiff(options: AnalyzeOptions = {}): Promise<DiffAnalysisResult> {
  const ref = options.ref || 'HEAD~1';
  const cwd = options.cwd || process.cwd();

  // Get diff data
  const diffContent = getGitDiff(ref, cwd);
  const files = getGitDiffNumstat(ref, cwd);

  // Try ruvector if available and requested
  if (options.useRuVector !== false) {
    const ruVectorAnalysis = await tryRuVectorAnalysis(diffContent);
    const ruVectorClassify = await tryRuVectorClassify(diffContent);

    if (ruVectorAnalysis.available && ruVectorAnalysis.analysis) {
      // Use ruvector results if available
      // This would integrate with ruvector's output format
    }
  }

  // Assess each file's risk
  const fileRisks = files.map(assessFileRisk);

  // Calculate overall risk
  const risk = assessOverallRisk(files, fileRisks);

  // Classify the change type
  const classification = classifyDiff(files);

  // Suggest reviewers
  const recommendedReviewers = suggestReviewers(files, fileRisks);

  // Generate summary
  const summary = generateSummary(files, risk, classification);

  return {
    ref,
    timestamp: new Date().toISOString(),
    files,
    risk,
    classification,
    fileRisks,
    recommendedReviewers,
    summary,
  };
}

function generateSummary(
  files: DiffFile[],
  risk: DiffRiskAssessment,
  classification: DiffClassification
): string {
  const parts: string[] = [];

  parts.push(`${classification.category.charAt(0).toUpperCase() + classification.category.slice(1)} change`);

  if (classification.subcategory) {
    parts.push(`(${classification.subcategory})`);
  }

  parts.push(`affecting ${files.length} file(s).`);
  parts.push(`Risk level: ${risk.overall} (score: ${risk.score}/100).`);

  if (risk.breakdown.securityConcerns.length > 0) {
    parts.push(`${risk.breakdown.securityConcerns.length} security concern(s) detected.`);
  }

  if (risk.breakdown.breakingChanges.length > 0) {
    parts.push(`${risk.breakdown.breakingChanges.length} potential breaking change(s).`);
  }

  return parts.join(' ');
}

// Export utility for CLI
export const DiffClassifier = {
  analyzeDiff,
  getGitDiff,
  getGitDiffStat,
  getGitDiffNumstat,
  assessFileRisk,
  assessOverallRisk,
  classifyDiff,
  suggestReviewers,
};

export default DiffClassifier;
