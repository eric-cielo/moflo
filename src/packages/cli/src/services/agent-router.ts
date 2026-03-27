/**
 * Agent Router Service
 *
 * Routes tasks to optimal agent types based on learned patterns
 * and hardcoded keyword matching. Learned patterns take priority
 * over static patterns (0.9 vs 0.8 confidence).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface RouteResult {
  agentType: string;
  confidence: number;
  reason: string;
}

export type AgentType =
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'researcher'
  | 'architect'
  | 'backend-dev'
  | 'frontend-dev'
  | 'devops'
  | 'security-architect'
  | 'security-auditor'
  | 'memory-specialist'
  | 'coordinator'
  | 'analyst'
  | 'optimizer';

// ============================================================================
// Agent Capabilities Map
// ============================================================================

export const AGENT_CAPABILITIES: Record<string, string[]> = {
  coder: ['code-generation', 'refactoring', 'debugging', 'implementation'],
  tester: ['unit-testing', 'integration-testing', 'coverage', 'test-generation'],
  reviewer: ['code-review', 'security-audit', 'quality-check', 'best-practices'],
  researcher: ['web-search', 'documentation', 'analysis', 'summarization'],
  architect: ['system-design', 'architecture', 'patterns', 'scalability'],
  'backend-dev': ['api', 'database', 'server', 'authentication'],
  'frontend-dev': ['ui', 'react', 'css', 'components'],
  devops: ['ci-cd', 'docker', 'deployment', 'infrastructure'],
  'security-architect': ['security-design', 'threat-modeling', 'auth-flow'],
  'security-auditor': ['vulnerability-scan', 'dependency-audit', 'compliance'],
  'memory-specialist': ['memory-management', 'caching', 'persistence'],
  coordinator: ['task-distribution', 'orchestration', 'scheduling'],
  analyst: ['data-analysis', 'metrics', 'reporting', 'monitoring'],
  optimizer: ['performance', 'profiling', 'optimization', 'benchmarking'],
};

// ============================================================================
// Static Task Patterns (regex -> agent type)
// ============================================================================

const TASK_PATTERNS: Array<{ regex: RegExp; agentType: string }> = [
  // Code patterns
  { regex: /implement|create|build|add|write code/i, agentType: 'coder' },
  { regex: /test|spec|coverage|unit test|integration/i, agentType: 'tester' },
  { regex: /review|audit|check|validate|security/i, agentType: 'reviewer' },
  { regex: /research|find|search|documentation|explore/i, agentType: 'researcher' },
  { regex: /design|architect|structure|plan/i, agentType: 'architect' },

  // Domain patterns
  { regex: /api|endpoint|server|backend|database/i, agentType: 'backend-dev' },
  { regex: /ui|frontend|component|react|css|style/i, agentType: 'frontend-dev' },
  { regex: /deploy|docker|ci|cd|pipeline|infrastructure/i, agentType: 'devops' },

  // Specialized patterns
  { regex: /security|auth|permission|rbac|oauth/i, agentType: 'security-architect' },
  { regex: /vulnerability|cve|dependency.*update|npm audit/i, agentType: 'security-auditor' },
  { regex: /performance|optimize|profile|benchmark|speed/i, agentType: 'optimizer' },
  { regex: /analyz|metric|report|monitor|dashboard/i, agentType: 'analyst' },
];

// ============================================================================
// Learned Patterns (loaded from persisted file)
// ============================================================================

interface LearnedPattern {
  pattern: string;
  agent: string;
  confidence: number;
}

function loadLearnedPatterns(projectRoot: string): Map<string, string> {
  const patterns = new Map<string, string>();
  const filePath = join(projectRoot, '.claude-flow', 'routing-outcomes.json');

  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      // Support both formats:
      // - Flat array (written by hooks-tools saveRoutingOutcome): [{ pattern, agentType, confidence, keywords }]
      // - Wrapped format: { patterns: [{ pattern, agent, confidence }] }
      const outcomes: Array<Record<string, unknown>> = Array.isArray(data)
        ? data
        : Array.isArray(data.patterns)
          ? data.patterns
          : [];

      for (const p of outcomes) {
        const agent = (p.agentType || p.agent) as string | undefined;
        const confidence = (p.confidence as number) || 0;
        const keywords = p.keywords as string[] | undefined;

        if (!agent || confidence <= 0.6) continue;

        // Use stored keywords for matching if available
        if (keywords && keywords.length > 0) {
          const keywordPattern = keywords.join('|');
          patterns.set(keywordPattern, agent);
        } else if (p.pattern) {
          patterns.set(p.pattern as string, agent);
        }
      }
    }
  } catch {
    // Learned patterns not available — use static only
  }

  return patterns;
}

// ============================================================================
// Router
// ============================================================================

export class AgentRouter {
  private learnedPatterns: Map<string, string>;

  constructor(projectRoot?: string) {
    const root = projectRoot || process.cwd();
    this.learnedPatterns = loadLearnedPatterns(root);
  }

  /**
   * Route a task description to the optimal agent type.
   *
   * Priority:
   * 1. Learned patterns (confidence 0.9)
   * 2. Static regex patterns (confidence 0.8)
   * 3. Default to 'coder' (confidence 0.5)
   */
  routeTask(description: string): RouteResult {
    const taskLower = description.toLowerCase();

    // 1. Check learned patterns first (higher priority from actual usage)
    for (const [pattern, agent] of this.learnedPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(taskLower)) {
          return {
            agentType: agent,
            confidence: 0.9,
            reason: `Matched learned pattern: ${pattern}`,
          };
        }
      } catch {
        // Invalid regex in learned pattern — skip
      }
    }

    // 2. Check static patterns
    for (const { regex, agentType } of TASK_PATTERNS) {
      if (regex.test(taskLower)) {
        return {
          agentType,
          confidence: 0.8,
          reason: `Matched pattern: ${regex.source}`,
        };
      }
    }

    // 3. Default
    return {
      agentType: 'coder',
      confidence: 0.5,
      reason: 'Default routing — no specific pattern matched',
    };
  }

  /**
   * Reload learned patterns from disk.
   */
  reload(projectRoot?: string): void {
    const root = projectRoot || process.cwd();
    this.learnedPatterns = loadLearnedPatterns(root);
  }

  /**
   * Get all available agent types.
   */
  getAgentTypes(): string[] {
    return Object.keys(AGENT_CAPABILITIES);
  }

  /**
   * Get capabilities for an agent type.
   */
  getCapabilities(agentType: string): string[] {
    return AGENT_CAPABILITIES[agentType] || [];
  }

  /**
   * Get the number of loaded learned patterns.
   */
  getLearnedPatternCount(): number {
    return this.learnedPatterns.size;
  }

  /**
   * Get routing statistics from persisted outcomes.
   */
  getStats(projectRoot?: string): {
    totalOutcomes: number;
    successRate: number;
    avgQuality: number;
    agentDistribution: Record<string, number>;
    learnedPatterns: number;
  } {
    const root = projectRoot || process.cwd();
    const filePath = join(root, '.claude-flow', 'routing-outcomes.json');

    const stats = {
      totalOutcomes: 0,
      successRate: 0,
      avgQuality: 0,
      agentDistribution: {} as Record<string, number>,
      learnedPatterns: this.learnedPatterns.size,
    };

    try {
      if (!existsSync(filePath)) return stats;
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      const outcomes: Array<Record<string, unknown>> = Array.isArray(data) ? data : [];

      stats.totalOutcomes = outcomes.length;
      if (outcomes.length === 0) return stats;

      let successCount = 0;
      let totalQuality = 0;

      for (const o of outcomes) {
        const agent = (o.agentType || o.agent || 'unknown') as string;
        const quality = (o.confidence as number) || 0;
        stats.agentDistribution[agent] = (stats.agentDistribution[agent] || 0) + 1;
        totalQuality += quality;
        if (quality >= 0.6) successCount++;
      }

      stats.successRate = Math.round((successCount / outcomes.length) * 100) / 100;
      stats.avgQuality = Math.round((totalQuality / outcomes.length) * 100) / 100;
    } catch {
      // Non-fatal
    }

    return stats;
  }

  /**
   * Write routing accuracy stats to learning.json for dashboard consumption.
   */
  syncLearningMetrics(projectRoot?: string): void {
    const root = projectRoot || process.cwd();
    const stats = this.getStats(root);
    const metricsPath = join(root, '.claude-flow', 'metrics', 'learning.json');

    try {
      const dir = dirname(metricsPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      writeFileSync(metricsPath, JSON.stringify({
        routingAccuracy: stats.successRate,
        totalOutcomes: stats.totalOutcomes,
        avgQuality: stats.avgQuality,
        learnedPatterns: stats.learnedPatterns,
        agentDistribution: stats.agentDistribution,
        lastUpdated: new Date().toISOString(),
      }, null, 2));
    } catch {
      // Non-fatal
    }
  }
}

// Singleton
let _router: AgentRouter | null = null;

export function getAgentRouter(projectRoot?: string): AgentRouter {
  if (!_router) {
    _router = new AgentRouter(projectRoot);
  }
  return _router;
}

/**
 * Convenience function matching the original router.js API.
 */
export function routeTask(description: string, projectRoot?: string): RouteResult {
  return getAgentRouter(projectRoot).routeTask(description);
}
